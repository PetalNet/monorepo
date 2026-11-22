import { spawn } from "node:child_process";

import { poolIdOf, type Offer } from "./pick.ts";

export interface Execution {
	code: number;
	out: string;
	log: string;
}
export type Failure = "quota" | "transient" | "bad-offer" | "auth" | "empty" | "unknown";

export function redact(text: string): string {
	return text
		.replace(
			/((?:[\w-]*(?:token|secret|password|api[_-]?key))["']?\s*[:=]\s*)(["'])(.*?)\2/giu,
			"$1$2[REDACTED]$2",
		)
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
			"[REDACTED PRIVATE KEY]",
		)
		.replace(
			/(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]+|AIza[\w-]+|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gu,
			"[REDACTED]",
		)
		.replace(
			/((?:authorization["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?|bearer\s+|(?:[\w-]*(?:token|secret|password|api[_-]?key))["']?\s*[:=]\s*["']?))[^\s"',;}]+/giu,
			"$1[REDACTED]",
		);
}

export function hasCredentials(text: string): boolean {
	return redact(text) !== text;
}

export function routeDepth(): number {
	const value = process.env["ROUTE_DEPTH"] ?? "0";
	return /^\d+$/u.test(value) ? Number(value) : 4;
}

/** Only stderr's adapter protocol lines carry failure or reset metadata. */
export function adapterErrors(result: Execution): string {
	return result.log
		.split(/\r?\n/u)
		.filter((line) => /^(?:AGY_ERROR:|ERROR:)/u.test(line))
		.join("\n");
}

export function classify(result: Execution): Failure | null {
	if (result.code === 0 && result.out.trim()) {
		if (result.out.trim() === "What would you like to work on?") {
			return "empty";
		}

		return null;
	}

	const text = adapterErrors(result);

	if (/\b429\b|RESOURCE_EXHAUSTED|Resets in|\b(?:usage limit|rate limit|quota)\b/iu.test(text)) {
		return "quota";
	}

	if (/model_not_found|\b400\b[\s\S]*not supported|model[^\n]*not supported/iu.test(text)) {
		return "bad-offer";
	}

	if (
		/\b(?:401|403)\b|unauthenticated|invalid.{0,10}(?:token|api.key)|not logged in|authentication|sign(?:ed)?[ -]out/iu.test(
			text,
		)
	) {
		return "auth";
	}

	if (/\b5\d\d\b|interrupted|timed? ?out|ECONNRESET|ETIMEDOUT/iu.test(text)) {
		return "transient";
	}

	if (!result.out.trim() || result.out.trim() === "What would you like to work on?") {
		return result.code === 0 ? "empty" : "unknown";
	}

	return result.code === 0 ? null : "unknown";
}

export function resetTime(text: string, now: number): number {
	const duration = /Resets in\s+([^\n]+)/iu.exec(text)?.[1];

	if (duration) {
		let ms = 0;

		for (const match of duration.matchAll(
			/(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)/giu,
		)) {
			const unit = match[2]?.[0]?.toLowerCase();

			ms +=
				Number(match[1]) *
				(unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000);
		}

		if (ms > 0) {
			return now + ms;
		}
	}

	const iso = /(?:reset(?:s|_at)?)[^\n]*?(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))/iu.exec(
		text,
	)?.[1];

	if (iso && Date.parse(iso) > now) {
		return Date.parse(iso);
	}

	return now + 3600000;
}

export function execute(
	command: string,
	args: string[],
	input: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<Execution> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			// Builders run for hours; a 30-minute cap killed them mid-PR (2026-11-19).
			timeout: Number(process.env["ROUTE_TIMEOUT_MIN"] ?? 360) * 60 * 1000,
		});
		let out = "";
		let log = "";

		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			out += chunk;
		});

		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			log += chunk;
		});

		child.on("error", () => {
			log += "\nERROR: adapter could not start";
		});

		child.stdin.on("error", () => {
			/* Early adapter exit can close stdin before the brief is consumed. */
		});

		child.on("close", (code, signal) => {
			resolve({
				code: code ?? 1,
				out,
				log: signal ? `${log}\nERROR: interrupted (${signal})` : log,
			});
		});

		child.stdin.end(input);
	});
}

export function launch(offer: Offer, brief: string, cwd: string): Promise<Execution> {
	// A helper this agent routes for review can then avoid the exact model that wrote the work.
	const depth = routeDepth();
	if (depth >= 4) throw new Error("router nesting limit reached (maximum 4)");
	const expected = poolIdOf({ id: offer.model, provider: offer.provider, score: offer.score });
	if (
		!offer.pool ||
		offer.pool.id !== expected ||
		!(
			offer.provider === "codex" ||
			offer.provider === "gemini" ||
			offer.provider.startsWith("agy-")
		)
	)
		throw new Error("provider and execution pool do not match");
	const env = { ...process.env, ROUTE_PARENT_MODEL: offer.model, ROUTE_DEPTH: String(depth + 1) };

	if (offer.provider === "codex") {
		return execute(
			"codex",
			[
				"exec",
				"--skip-git-repo-check",
				"-m",
				offer.model,
				"-c",
				`model_reasoning_effort=${offer.effort}`,
				"--dangerously-bypass-approvals-and-sandbox",
				"-",
			],
			brief,
			cwd,
			env,
		);
	}

	return execute(
		"agy",
		[
			"-p",
			brief,
			"--model",
			offer.effort === "default" ? offer.model : `${offer.model}-${offer.effort}`,
			...(offer.effort === "default" ? [] : ["--effort", offer.effort]),
			"--dangerously-skip-permissions",
			"--output-format",
			"text",
		],
		"",
		cwd,
		env,
	);
}
