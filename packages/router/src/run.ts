/* oxlint-disable no-await-in-loop, no-labels -- Fallback attempts are sequential; the label stops both retry and selection loops on a terminal result. */
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

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
	launch?: (offer: Offer, brief: string, cwd: string) => Promise<Execution> | Execution;
	sleep?: (ms: number) => unknown;
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
	let attempt = 0;
	let code = 3;
	let tail = "No available offer";
	let injectCode: number;

	try {
		routing: while (true) {
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
				break;
			}

			const { offer } = selected;
			const pool = selected.offer.pool;

			attempted.add(offer.id);

			for (let retry = 0; retry < 2; retry++) {
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
					briefHash: createHash("sha256").update(brief).digest("hex"),
					dataClass: options.dataClass ?? "unknown",
					briefName: options.briefName ?? "",
				};

				await appendEvent(dir, { ...metadata, event: "launch" });

				options.report?.(
					`attempt ${String(attempt)}: ${offer.id} plan=${pool.plan} pool=${pool.id}`,
				);

				const handoff = offer.provider === "claude";
				const result = handoff
					? {
							code: 5,
							out: `Claude handoff: model=${offer.model} effort=${offer.effort}; caller must launch this brief.`,
							log: "",
						}
					: await (options.launch ?? launch)(offer, brief, cwd);
				const failureClass = handoff ? null : classify(result);
				const endedAt = Date.now();

				tail = redact(result.out);
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
					status: handoff ? "handoff" : failureClass ? "failed" : "completed",
				});

				options.report?.(
					`attempt ${String(attempt)}: ${handoff ? "handoff" : (failureClass ?? "completed")}`,
				);

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

				await (options.sleep ?? setTimeout)(30000);
			}
		}
	} finally {
		const injected = await execute(
			options.injectPath,
			["--source", "route", "--key", runId],
			`route ${runId} exit=${String(code)}; output=${outputPath}; log=${logPath}\n${tail.slice(-4000)}`,
			cwd,
		);

		await appendEvent(dir, { event: "inject", runId, exitCode: injected.code, at: Date.now() });

		options.report?.(
			`run ${runId}: output=${outputPath}; inject=${injected.code === 0 ? "queued" : "failed"}`,
		);

		injectCode = injected.code;
	}

	if (injectCode !== 0) {
		throw new Error(`run ${runId}: cc-link-inject failed (result saved)`);
	}

	return { runId, code, outputPath };
}
