#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo, homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { messageSource, parseMessageSource } from "@petalnet/harness-hooks/message-source";
import {
	defaultSourceDeps,
	readGoogleAi,
	sourceConfigFromEnv,
} from "@petalnet/harness-hooks/quota-sources";

import { redact, routeDepth } from "./adapters.ts";
import { classRefusal, effectiveDataClass, parseDataClass, resolveTarget } from "./policy.ts";
import { defaultTarget, quotaMain } from "./quota-pacing-command.ts";
import { launchOptions, routeCommand } from "./route-args.ts";
import { notify, run } from "./run.ts";
import { appendEvent, validateLedger } from "./state.ts";
import { readCodexAccountQuota } from "./telemetry.ts";

const USAGE =
	"usage: route run <model>[:<effort>] --class <public|sensitive|parcs> <brief | file | ->";

async function launch(argv: string[]): Promise<number> {
	const runId = crypto.randomUUID();
	const home = homedir();
	const dir = path.join(home, ".local/state/router");
	const cwd = process.cwd();
	const hermesHome = process.env["HERMES_HOME"];
	const injectPath =
		process.env["ROUTE_NO_INJECT"] === "1" || home !== userInfo().homedir
			? "true"
			: path.join(
					hermesHome && hermesHome.length > 0 ? hermesHome : path.join(home, ".hermes-janet"),
					"plugins/hermes-cc-link/bin/cc-link-inject",
				);
	const notice = { runId, dir, cwd, injectPath };
	let acceptanceRef: string | null = null;

	const report = (line: string) => process.stdout.write(`${redact(line)}\n`);
	const reject = async (code: number, reason: string) => {
		process.stderr.write(`route: ${reason}\n`);

		const status =
			code === 130
				? "cancellation requested"
				: code === 3 || code === 4
					? "launch refused"
					: "launch failed";
		const injection = await notify({ ...notice, code, status, details: reason, acceptanceRef });

		report(`run ${runId}: ${status}; inject=${injection === 0 ? "queued" : "failed"}`);

		return code;
	};

	try {
		const parsed = (() => {
			try {
				return parseArgs({ args: argv, allowPositionals: true, options: launchOptions });
			} catch {
				return undefined;
			}
		})();

		if (!parsed) {
			return await reject(2, USAGE);
		}

		const { positionals, values } = parsed;
		const [command, first, ...rest] = positionals;

		if (command !== "run" || !first) {
			return await reject(2, USAGE);
		}

		const legacy =
			values.kind !== undefined ||
			values.tier !== undefined ||
			values["data-class"] !== undefined ||
			values["not-vendor"] !== undefined ||
			values["allow-superseded"] === true;
		const startsWithModel = resolveTarget(first.split(":")[0] ?? "") !== undefined;
		const model = rest.length > 0 && (!legacy || startsWithModel) ? first : undefined;
		const words = model ? rest : [first, ...rest];

		if (rest.length === 0 && startsWithModel && !legacy) {
			return await reject(2, USAGE);
		}

		if (routeDepth() >= 4) {
			return await reject(4, "nesting limit reached (maximum 4)");
		}

		const legacyClass = values["data-class"];
		const flagClass = parseDataClass(values.class ?? legacyClass ?? "public");
		const promiseId = values.promise === undefined ? undefined : Number(values.promise);
		const declaredSource =
			values["source-kind"] === undefined ? undefined : parseMessageSource(values["source-kind"]);

		if (
			flagClass === undefined ||
			(legacyClass !== undefined && parseDataClass(legacyClass) !== flagClass) ||
			(promiseId !== undefined && (!Number.isSafeInteger(promiseId) || promiseId <= 0)) ||
			(values["source-kind"] !== undefined && declaredSource === undefined)
		) {
			return await reject(2, "invalid launch options");
		}

		acceptanceRef = promiseId === undefined ? null : `promise:${String(promiseId)}`;

		const asked = words.join(" ");
		const briefFile = words.length === 1 && existsSync(asked) ? asked : undefined;
		const brief =
			asked === "-" ? readFileSync(0, "utf8") : briefFile ? readFileSync(briefFile, "utf8") : asked;

		if (!brief.trim()) {
			return await reject(2, "the brief is empty");
		}

		const sourceKind = messageSource(brief, declaredSource ?? "task-brief");
		let task = brief;
		let acceptanceDigest: string | undefined;

		if (promiseId !== undefined) {
			const { Ledger, configFromEnv, depsFromEnv } =
				await import("@petalnet/harness-hooks/promise-ledger");
			const ledger = new Ledger(configFromEnv(), depsFromEnv());

			try {
				const acceptance = ledger.acceptance(promiseId);

				if (!acceptance || ledger.item(promiseId)?.state !== "open") {
					throw new Error(`promise ${String(promiseId)} needs an active acceptance record`);
				}

				const snapshot = JSON.stringify(acceptance, null, 2);

				acceptanceDigest = createHash("sha256").update(snapshot).digest("hex");
				task = `${brief}\n\nActive promise ${String(promiseId)}. Carry these requirements through the current task. Null evidence marks an unresolved check.\n${snapshot}`;
			} finally {
				ledger.close();
			}
		}

		const dataClass = effectiveDataClass(flagClass, task);
		const allowClaude = values["allow-claude"] === true;
		if (dataClass !== flagClass) {
			report(`class raised to ${dataClass} by the brief`);
		}

		const target = model
			? resolveTarget(model, allowClaude || dataClass === "parcs")
			: await defaultTarget(dir, dataClass, values["not-vendor"]);

		if (!target) {
			return await reject(3, model ? "unsupported model or effort" : "no eligible default model");
		}

		const refusal = classRefusal(target, dataClass, allowClaude);

		if (refusal) {
			return await reject(3, refusal);
		}

		if (!model) {
			report(`selected ${target.model}:${target.effort}`);
		}

		if (target.pool.plan === "claude") {
			await appendEvent(dir, {
				event: "handoff",
				runId,
				model: target.model,
				effort: target.effort,
				plan: "claude",
				kind: "code",
				dataClass,
				sourceKind,
				acceptanceRef,
				acceptanceDigest: acceptanceDigest ?? null,
				at: Date.now(),
			});

			const continuation = acceptanceRef
				? `
Read the active goal and checks with promise acceptance ${String(promiseId)}.`
				: "";
			const details = `Claude handoff: model=${target.model} effort=${target.effort}; caller must launch explicitly on the claude plan and put "ROUTED ${runId}" in the subagent prompt${continuation}`;

			report(details);

			const injection = await notify({
				...notice,
				code: 5,
				status: "manual handoff",
				details,
				acceptanceRef,
			});

			report(`run ${runId}: inject=${injection === 0 ? "queued" : "failed"}`);

			return 5;
		}

		const controller = new AbortController();
		const cancel = () => {
			controller.abort();
		};

		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12 * 60 * 60 * 1000)]);

		process.on("SIGINT", cancel);
		process.on("SIGTERM", cancel);

		try {
			const config = sourceConfigFromEnv();
			const deps = defaultSourceDeps();
			const result = await run({
				...notice,
				target,
				brief: task,
				dataClass,
				sourceKind,
				...(promiseId === undefined ? {} : { promiseId }),
				...(acceptanceDigest === undefined ? {} : { acceptanceDigest }),
				signal,
				codexSessionsDir: config.codexSessionsDir,
				readQuota: (service) => {
					if (service === "codex") {
						return readCodexAccountQuota(config.codexCmd);
					}

					return service === "google-ai" ? readGoogleAi(config, deps) : Promise.resolve(undefined);
				},
				briefName:
					dataClass === "public"
						? briefFile
							? path.basename(briefFile, ".md")
							: brief.trim().slice(0, 60)
						: "",
				legacy: path.join(home, ".local/state/agy-build"),
				report,
			});

			process.stdout.write(readFileSync(result.outputPath, "utf8"));

			return result.injectCode === 0 || result.code === 130 ? result.code : 1;
		} finally {
			process.off("SIGINT", cancel);
			process.off("SIGTERM", cancel);
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return reject(130, "cancelled before the builder started");
		}

		if (error instanceof Error && error.name === "TimeoutError") {
			return reject(1, "12-hour run limit reached");
		}

		// Errors from brief and promise reads can include private paths and content.
		return reject(1, "could not complete the launch");
	}
}

const argv = process.argv.slice(2);

try {
	const command = routeCommand(argv);

	if (command?.value === "ls" || command?.value === "pace") {
		process.exitCode = await quotaMain(argv.toSpliced(command.index, 1));
	} else if (argv[0] === "validate-ledger" && argv.length <= 2) {
		const result = await validateLedger(
			argv[1] ?? path.join(homedir(), ".local/state/router/ledger.jsonl"),
		);

		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode = result.invalid.length === 0 ? 0 : 1;
	} else if (command?.value === "run" || argv[0] === "run") {
		process.exitCode = await launch(argv);
	} else {
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = 2;
	}
} catch {
	process.stderr.write("route: command failed\n");
	process.exitCode = 1;
}
