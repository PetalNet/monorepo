import { spawn } from "node:child_process";

import type { Target } from "./policy.ts";
import { readProviderEvents, type ProviderTelemetry } from "./telemetry.ts";

export interface Execution {
	code: number;
	out: string;
	log: string;
	started?: boolean;
	telemetry?: ProviderTelemetry;
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

export function execute(
	command: string,
	args: string[],
	input: string,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<Execution> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env,
			signal,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let started = false;

		child.once("spawn", () => {
			started = true;
		});

		let out = "";
		let log = "";
		let cancelTimer: NodeJS.Timeout | undefined;
		const escalate = () => {
			cancelTimer = setTimeout(() => {
				child.kill("SIGKILL");
				child.stdout.destroy();
				child.stderr.destroy();
			}, 2000);

			cancelTimer.unref();
		};

		if (signal?.aborted) {
			escalate();
		} else {
			signal?.addEventListener("abort", escalate, { once: true });
		}

		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			out += chunk;
		});

		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			log += chunk;
		});

		child.on("error", () => {
			if (!signal?.aborted) {
				log += "\nERROR: adapter could not start";
			}
		});

		child.stdin.on("error", () => {
			/* Early adapter exit can close stdin before the brief is consumed. */
		});

		child.on("close", (code, exitSignal) => {
			clearTimeout(cancelTimer);
			signal?.removeEventListener("abort", escalate);

			resolve({
				code: code ?? 1,
				started,
				out,
				log: exitSignal ? `${log}\nERROR: interrupted (${exitSignal})` : log,
			});
		});

		child.stdin.end(input);
	});
}

export function launch(
	offer: Target,
	brief: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<Execution> {
	const depth = routeDepth();

	if (depth >= 4) {
		throw new Error("router nesting limit reached (maximum 4)");
	}

	if (offer.pool.plan !== "codex" && offer.pool.plan !== "google-ai") {
		throw new Error("no execution adapter for this plan");
	}

	const env = { ...process.env, ROUTE_PARENT_MODEL: offer.model, ROUTE_DEPTH: String(depth + 1) };
	const codex = offer.pool.plan === "codex";

	return execute(
		codex ? "codex" : "agy",
		codex
			? [
					"exec",
					"--json",
					"--skip-git-repo-check",
					"-m",
					offer.model,
					"-c",
					`model_reasoning_effort=${offer.effort}`,
					"--dangerously-bypass-approvals-and-sandbox",
					"-",
				]
			: [
					"-p",
					brief,
					"--model",
					offer.effort === "default" ? offer.model : `${offer.model}-${offer.effort}`,
					...(offer.effort === "default" ? [] : ["--effort", offer.effort]),
					"--dangerously-skip-permissions",
					"--output-format",
					"stream-json",
				],
		codex ? brief : "",
		cwd,
		env,
		signal,
	).then((result) => {
		const { out, errors, telemetry } = readProviderEvents(codex ? "codex" : "agy", result.out);

		return { ...result, out, log: errors ? `${result.log}\n${errors}` : result.log, telemetry };
	});
}
