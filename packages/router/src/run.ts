/* oxlint-disable no-await-in-loop, no-labels -- Fallback attempts are sequential; the label stops both retry and selection loops on a terminal result. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { tagMessage, type MessageSource } from "@petalnet/harness-hooks/message-source";
import type { ServiceName, ServiceReport } from "@petalnet/harness-hooks/quota-sources";

import {
	adapterErrors,
	classify,
	execute,
	launch,
	redact,
	resetTime,
	type Execution,
} from "./adapters.ts";
import { pick, type Catalog, type Offer, type State } from "./pick.ts";
import { appendEvent, markUnavailable, readAvailability, seedLedger } from "./state.ts";
import { quotaSnapshot, readCodexSession } from "./telemetry.ts";

interface RunOptions {
	catalog: Catalog;
	state: State;
	kind: string;
	tier: string;
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
		offer: Offer,
		brief: string,
		cwd: string,
		signal?: AbortSignal,
	) => Promise<Execution> | Execution;
	sleep?: (ms: number, signal?: AbortSignal) => unknown;
	report?: (line: string) => void;
}

export async function run(
	options: RunOptions,
): Promise<{ runId: string; code: number; outputPath: string }> {
	const { catalog, state, kind, tier, brief, cwd, dir } = options;

	if (!brief.trim() || !(await stat(cwd)).isDirectory()) {
		throw new Error("invalid brief or workdir");
	}

	await seedLedger(dir, options.legacy);
	const runId = crypto.randomUUID();

	await mkdir(path.join(dir, "runs"), { recursive: true, mode: 0o700 });
	const outputPath = path.join(dir, "runs", `${runId}.out`);
	const logPath = path.join(dir, "runs", `${runId}.log`);

	await writeFile(outputPath, "", { mode: 0o600 });
	await writeFile(logPath, "", { mode: 0o600 });
	const attempted = new Set<string>();
	const exhaustedPools = new Set<string>();
	const { signal } = options;
	let attempt = 0;
	let code = 3;
	let tail = "No available offer";
	let injectCode: number;
	let hasOutput = false;
	const acceptanceRef =
		options.promiseId === undefined ? null : `promise:${String(options.promiseId)}`;
	const sample = async (pool: NonNullable<Offer["pool"]>) => {
		if (!pool.service || !options.readQuota || signal?.aborted) {
			return null;
		}

		const report = await options.readQuota(pool.service).catch(() => undefined);

		return quotaSnapshot(pool, report, Date.now());
	};

	try {
		routing: while (true) {
			if (signal?.aborted) {
				break;
			}

			const current = {
				...state,
				nowMs: Date.now(),
				availability: await readAvailability(dir),
				deny: [...state.deny, ...attempted],
				blocks: [
					...state.blocks,
					...Array.from(exhaustedPools, (pool) => ({
						pool,
						untilMs: Number.MAX_SAFE_INTEGER,
						why: "quota failure in this run",
					})),
				],
				runnableOnly: true,
			};
			const selection = pick(catalog, kind, tier, current);
			const selected = selection.ranked[0];

			if (!selected?.offer.pool) {
				const superseded = selection.excluded.find(
					(r) => r.supersededBy && !r.reasons.includes("not the caller's choice"),
				);

				if (attempt === 0 && state.choice && superseded?.supersededBy) {
					tail = `${superseded.offer.model}:${superseded.offer.effort} is superseded by ${superseded.supersededBy}. For reproducibility, rerun with --allow-superseded.`;
					await writeFile(outputPath, `${tail}\n`, { mode: 0o600 });
				}

				break;
			}

			const { offer } = selected;
			const pool = selected.offer.pool;

			attempted.add(offer.id);

			for (let retry = 0; retry < 2; retry++) {
				const handoff = offer.provider === "claude";
				const quotaBefore = handoff ? null : await sample(pool);

				if (signal?.aborted) {
					break routing;
				}

				attempt++;
				const startedAt = Date.now();
				const metadata = {
					runId,
					attempt,
					model: offer.model,
					effort: offer.effort,
					plan: pool.plan,
					pool: pool.id,
					kind,
					tier,
					selectedTier: selection.tier,
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
					...(selected.supersededBy ? { supersessionOverride: selected.supersededBy } : {}),
				};

				await appendEvent(dir, { ...metadata, event: "launch" });

				options.report?.(
					`attempt ${String(attempt)}: ${offer.id} plan=${pool.plan} pool=${pool.id}`,
				);

				const result: Execution = handoff
					? {
							code: 5,
							out: `Claude handoff: model=${offer.model} effort=${offer.effort}; caller must launch this brief.`,
							log: "",
						}
					: await (options.launch ?? launch)(offer, brief, cwd, signal);
				const cancelled = signal?.aborted === true;
				const failureClass = handoff || cancelled ? null : classify(result);
				const endedAt = Date.now();
				const revision = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
					cwd,
					encoding: "utf8",
					timeout: 2000,
				});
				const artifactRevision = revision.status === 0 ? revision.stdout.trim() : null;
				const nativeSessionId = result.telemetry?.nativeSessionId ?? null;
				const codexRollout = offer.provider === "codex" && options.codexSessionsDir !== undefined;
				const session =
					codexRollout && nativeSessionId && !signal?.aborted && options.codexSessionsDir
						? await readCodexSession(
								options.codexSessionsDir,
								nativeSessionId,
								startedAt,
								signal,
							).catch(() => undefined)
						: undefined;
				const quotaAfter = handoff
					? null
					: codexRollout
						? session?.quota
							? quotaSnapshot(pool, session.quota.report, session.quota.at)
							: null
						: await sample(pool);
				const status = cancelled
					? "cancelled"
					: handoff
						? "handoff"
						: failureClass
							? "failed"
							: "completed";

				tail = redact(result.out);
				hasOutput = tail.length > 0;
				await writeFile(outputPath, tail, { mode: 0o600 });

				await appendFile(
					logPath,
					`attempt ${String(attempt)}: ${offer.id}\n${redact(result.log)}\n${tail}\n`,
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

				if (cancelled) {
					break routing;
				}

				if (handoff || failureClass === null) {
					code = handoff ? 5 : 0;

					break routing;
				}

				code = 1;

				if (failureClass === "empty" || failureClass === "unknown") {
					break routing;
				}

				if (failureClass === "quota") {
					exhaustedPools.add(pool.id);
				}

				if (failureClass === "quota") {
					await markUnavailable(
						dir,
						"cooldowns",
						pool.id,
						resetTime(adapterErrors(result), endedAt),
					);
				}

				if (failureClass === "bad-offer") {
					await markUnavailable(dir, "badOffers", `${pool.plan}:${offer.id}`, endedAt + 86400000);
				}

				if (failureClass === "auth") {
					await markUnavailable(dir, "signedOut", pool.plan, endedAt);
				}

				if (failureClass === "transient" && retry === 1) {
					attempted.add(offer.model);
				}

				if (failureClass !== "transient" || retry === 1) {
					break;
				}

				await (options.sleep ?? ((ms, abort) => setTimeout(ms, undefined, { signal: abort })))(
					30000,
					signal,
				);
			}
		}
	} catch (error) {
		if (!signal?.aborted) {
			code = 1;
			tail = "Router failed before producing an outcome. See the attempt ledger.";

			throw error;
		}
	} finally {
		if (signal?.aborted) {
			code = 130;

			tail =
				"Cancellation requested. Verify any work or processes started outside the adapter before resuming.";

			if (!hasOutput) {
				await writeFile(outputPath, `${tail}\n`, { mode: 0o600 });
			}
		}

		const continuation =
			options.promiseId === undefined
				? ""
				: `\nActive goal and acceptance checks: promise acceptance ${String(options.promiseId)}. Confirm the remaining checks before closing the promise.`;
		const status =
			code === 0
				? "process completed"
				: code === 5
					? "manual handoff"
					: code === 130
						? "cancellation requested"
						: "blocked";
		const timeout = AbortSignal.timeout(20_000);
		const injectSignal = signal && !signal.aborted ? AbortSignal.any([signal, timeout]) : timeout;
		const injected = await execute(
			options.injectPath,
			["--source", "route", "--key", runId],
			tagMessage(
				"automated-notification",
				`route ${runId} exit=${String(code)}; ${status}; output=${outputPath}; log=${logPath}${continuation}\n${tail.slice(-4000)}`,
			),
			cwd,
			process.env,
			injectSignal,
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

		options.report?.(
			`run ${runId}: output=${outputPath}; inject=${injected.code === 0 ? "queued" : "failed"}`,
		);

		injectCode = injected.code;

		if (signal?.aborted) {
			code = 130;
		}
	}

	if (injectCode !== 0 && code !== 130) {
		throw new Error(`run ${runId}: cc-link-inject failed (result saved)`);
	}

	return { runId, code, outputPath };
}
