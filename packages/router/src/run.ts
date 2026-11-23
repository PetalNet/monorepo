import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import { tagMessage, type MessageSource } from "@petalnet/harness-hooks/message-source";
import type { ServiceName, ServiceReport } from "@petalnet/harness-hooks/quota-sources";

import { classify, execute, launch, redact, type Execution } from "./adapters.ts";
import type { Target } from "./policy.ts";
import { appendEvent, seedLedger } from "./state.ts";
import { quotaSnapshot, readCodexSession } from "./telemetry.ts";

interface RunOptions {
	target: Target;
	runId: string;
	brief: string;
	cwd: string;
	dir: string;
	legacy: string;
	injectPath: string;
	/** Recorded on every ledger event so viewers can apply the privacy class and show a name. */
	dataClass?: string;
	briefName?: string;
	sourceKind?: MessageSource;
	promiseId?: number;
	acceptanceDigest?: string;
	signal?: AbortSignal;
	readQuota?: (service: ServiceName) => Promise<ServiceReport | undefined>;
	codexSessionsDir?: string;
	launch?: (
		offer: Target,
		brief: string,
		cwd: string,
		signal?: AbortSignal,
	) => Promise<Execution> | Execution;
	report?: (line: string) => void;
}

interface Notice {
	runId: string;
	dir: string;
	cwd: string;
	injectPath: string;
	code: number;
	status: string;
	details: string;
	acceptanceRef?: string | null;
}

export async function notify(options: Notice): Promise<number> {
	const { runId, dir, cwd, injectPath, code, status, details, acceptanceRef = null } = options;
	const injected = await execute(
		injectPath,
		["--source", "route", "--key", runId],
		tagMessage(
			"automated-notification",
			`route ${runId} exit=${String(code)}; ${status}; ${details}`,
		),
		cwd,
		process.env,
		AbortSignal.timeout(20_000),
	);

	await appendEvent(dir, {
		event: "inject",
		runId,
		exitCode: injected.code,
		at: Date.now(),
		status,
		acceptanceRef,
		sourceKind: "automated-notification",
	});

	return injected.code;
}

export async function run(options: RunOptions) {
	const { target: offer, runId, brief, cwd, dir, signal } = options;
	const { pool } = offer;

	if (!brief.trim() || !(await stat(cwd)).isDirectory()) {
		throw new Error("invalid brief or workdir");
	}

	await seedLedger(dir, options.legacy);

	await mkdir(path.join(dir, "runs"), { recursive: true, mode: 0o700 });
	const outputPath = path.join(dir, "runs", `${runId}.out`);
	const logPath = path.join(dir, "runs", `${runId}.log`);

	await writeFile(outputPath, "", { mode: 0o600 });
	await writeFile(logPath, "", { mode: 0o600 });
	const acceptanceRef =
		options.promiseId === undefined ? null : `promise:${String(options.promiseId)}`;
	const sample = async () => {
		if (!pool.service || !options.readQuota || signal?.aborted) {
			return null;
		}

		const report = await options.readQuota(pool.service).catch(() => undefined);

		return quotaSnapshot(pool, report, Date.now());
	};

	const quotaBefore = await sample();

	signal?.throwIfAborted();
	const attempt = 1;
	const startedAt = Date.now();
	const metadata = {
		runId,
		attempt,
		model: offer.model,
		effort: offer.effort,
		plan: pool.plan,
		pool: pool.id,
		kind: "code",
		tier: "*",
		selectedTier: "*",
		outputPath,
		logPath,
		startedAt,
		routePid: process.pid,
		briefHash: createHash("sha256").update(brief).digest("hex"),
		dataClass: options.dataClass ?? "unknown",
		briefName: options.briefName ?? "",
		sourceKind: options.sourceKind ?? "task-brief",
		acceptanceRef,
		acceptanceDigest: options.acceptanceDigest ?? null,
		quotaBefore,
	};

	await appendEvent(dir, { ...metadata, event: "launch" });

	options.report?.(
		`attempt ${String(attempt)}: ${offer.model}:${offer.effort} plan=${pool.plan} pool=${pool.id}`,
	);

	const result: Execution = await (options.launch ?? launch)(offer, brief, cwd, signal);
	const cancelled = signal?.aborted === true;
	const failureClass = cancelled ? null : classify(result);
	const endedAt = Date.now();
	const revision = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd,
		encoding: "utf8",
		timeout: 2000,
	});
	const artifactRevision = revision.status === 0 ? revision.stdout.trim() : null;
	const nativeSessionId = result.telemetry?.nativeSessionId ?? null;
	const codexRollout = pool.plan === "codex" && options.codexSessionsDir !== undefined;
	const session =
		codexRollout && nativeSessionId && !signal?.aborted && options.codexSessionsDir
			? await readCodexSession(options.codexSessionsDir, nativeSessionId, startedAt, signal).catch(
					() => undefined,
				)
			: undefined;
	const quotaAfter = codexRollout
		? session?.quota
			? quotaSnapshot(pool, session.quota.report, session.quota.at)
			: null
		: await sample();
	const status = cancelled ? "cancelled" : failureClass ? "failed" : "completed";
	const tail = redact(result.out);
	await writeFile(outputPath, tail, { mode: 0o600 });

	await appendFile(
		logPath,
		`attempt ${String(attempt)}: ${offer.model}:${offer.effort}\n${redact(result.log)}\n${tail}\n`,
		{ mode: 0o600 },
	);

	await appendEvent(dir, {
		...metadata,
		event: "outcome",
		endedAt,
		durationMs: endedAt - startedAt,
		exitCode: result.code,
		failureClass,
		status,
		artifactRevision,
		quotaAfter,
		nativeSessionId,
		respondingModel: session?.respondingModel ?? result.telemetry?.respondingModel ?? null,
		usage: result.telemetry?.usage ?? null,
		cost: result.telemetry?.cost ?? {
			charge: null,
			apiEquivalent: null,
			planOpportunity: null,
		},
	});

	options.report?.(`attempt ${String(attempt)}: ${failureClass ?? status}`);

	const code = cancelled ? 130 : failureClass ? 1 : 0;
	const continuation =
		options.promiseId === undefined
			? ""
			: `
Active goal and acceptance checks: promise acceptance ${String(options.promiseId)}. Confirm the remaining checks before closing the promise.`;
	const injectCode = await notify({
		...options,
		code,
		status: cancelled
			? "cancellation requested"
			: result.started === false
				? "launch failed"
				: failureClass
					? "blocked"
					: "process completed",
		details: `output=${outputPath}; log=${logPath}${continuation}
${tail.slice(-4000) || (failureClass ? redact(result.log).slice(-4000) : "")}`,
		acceptanceRef,
	});

	options.report?.(
		`run ${runId}: output=${outputPath}; inject=${injectCode === 0 ? "queued" : "failed"}`,
	);

	return { runId, code, outputPath, injectCode };
}
