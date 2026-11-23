// route: pick a builder offer (model, effort, plan, pool) for a brief from live quota state.
//
//   route pick --dry --kind <code|ui|research|write|sweep|cyber|architecture> --tier <S|A|B|C|top|mid|fast|cheap>
//              --data-class <public|sensitive|parcs> <brief-file>
//
// Exit codes: 0 completed/picked, 1 failed, 2 bad input, 3 no eligible offer, 5 Claude handoff.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { userInfo, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	defaultSourceDeps,
	readClaude,
	readCodex,
	readGoogleAi,
	sourceConfigFromEnv,
} from "@petalnet/harness-hooks/quota-sources";

import { redact, hasCredentials, routeDepth } from "./adapters.ts";
import { discoverCodex, withCodexCatalog, checkCodexAlerts } from "./codex-catalog.ts";
import { EFFORTS, readEvidence } from "./evidence.ts";
import { readOpenEvidence } from "./open-evidence.ts";
import { BLOCKS, POOLS, PLANS, type Catalog, type DataClass, type Pick, pick } from "./pick.ts";
import { pace, readPacingCodex } from "./quota-pacing-command.ts";
import { run } from "./run.ts";
import { appendEvent, readAvailability } from "./state.ts";

const USAGE = `usage:
  route ls  [--for <kind>] [--class <public|sensitive|parcs>] [--not-vendor <maker>]
            what you can run right now: model:effort, plan, quota, quality for <kind>, cost, time
  route run <model>[:<effort>] [--for <kind>] [--class <class>] [--allow-superseded] <task | task-file | ->
            run your pick on a task given inline, as a file, or on stdin; route checks policy and quota, logs it and pings Janet when it ends
  route why <model>[:<effort>] [--for <kind>] [--class <class>]
            why a model is or isn't runnable, with its evidence
  route pace             recommend additional builders from live quota and recent runs
  route refresh-codex
            refresh installed-client models and post new-model or stale-client alerts once
  route pull-evidence
kinds: code ui research write sweep cyber architecture (default code). class defaults to public and rises
automatically for briefs that carry credentials (sensitive) or PARCS/Bridgeton (parcs).`;
const KINDS = new Set(["code", "ui", "research", "write", "sweep", "cyber", "architecture"]);

/**
 * A missing file means "none"; a corrupt one is an error, so a broken cooldown list never reads as
 * all-clear.
 */
function readJson<T>(file: string, fallback?: T): T {
	let text: string;

	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return fallback;
		}

		throw new Error(`cannot read ${file}`, { cause: error });
	}

	return JSON.parse(text) as T;
}

/** Returns the brief text, or an error message when it is missing, empty or whitespace-only. */
export function readBrief(file: string | undefined): { text: string } | { error: string } {
	if (!file) {
		return { error: "no brief file given" };
	}

	let text: string;

	try {
		text = readFileSync(file, "utf8");
	} catch {
		return { error: `brief ${file} is missing or unreadable` };
	}

	return text.trim() === "" ? { error: `brief ${file} is empty` } : { text };
}

/**
 * "Parcs Labs" is Parker's own LLC, not the Bridgeton PARCS job, so it does not count. A brief
 * carrying a credential is sensitive whatever the flag says; the class only ever rises.
 */
export function effectiveDataClass(flag: DataClass, brief: string): DataClass {
	if (flag === "parcs" || /\bBridgeton\b|\bPARCS\b(?!\s*Labs)/iu.test(brief)) {
		return "parcs";
	}

	return hasCredentials(brief) ? "sensitive" : flag;
}

/** One line per quota source, as the reader summarized it. */
export function formatQuota(reports: Record<string, { status: string; summary: string }>): string {
	return Object.entries(reports)
		.map(([name, r]) => `quota ${name}: ${r.status === "ok" ? r.summary : r.status}`)
		.join("\n");
}

/** The runnable menu, best first: what a caller needs to choose. */
export function formatMenu(result: Pick, kind: string): string {
	if (result.ranked.length === 0) {
		return `nothing runnable for ${kind} right now; route why <model> shows the reasons`;
	}

	const rows = result.ranked.map(({ offer: o, evidence: e, source }) => [
		`${o.model}:${o.effort}`,
		o.pool?.id ?? "-",
		e ? `Q=${e.q.toFixed(2)}` : `score=${String(o.score)}`,
		e ? `$${e.cost.toFixed(2)}` : "",
		e ? `~${String(Math.round(e.seconds / 60))}m` : "",
		source === "evidence" ? "" : o.unproven ? "(new, unproven; family prior)" : "(no evidence)",
	]);
	const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));

	return [
		`runnable for ${kind} (best first; Q = expected quality 0-1 per task):`,
		...rows.map(
			(r) =>
				`  ${r
					.map((cell, i) => cell.padEnd(widths[i] ?? 0))
					.join("  ")
					.trimEnd()}`,
		),
		`${String(result.excluded.filter((x) => !x.reasons.includes("not the caller's choice")).length)} more not runnable: route why <model>`,
	].join("\n");
}

/** Every offer of one model, runnable or not, with the reasons. */
export function formatWhy(result: Pick, model: string): string {
	const mine = [
		...result.ranked.map((r) => ({ ...r, reasons: [] as string[] })),
		...result.excluded,
	].filter((r) => r.offer.model === model);

	if (mine.length === 0) {
		return `${model}: not in the catalog (route ls lists what exists)`;
	}

	return mine
		.map(({ offer: o, reasons, evidence: e }) => {
			const why = reasons.filter((r) => r !== "not the caller's choice");

			return `${o.model}:${o.effort} [${o.pool?.id ?? "-"}] ${why.length > 0 ? `blocked: ${why.join("; ")}` : "runnable"}${e ? ` Q=${e.q.toFixed(2)} cost=$${e.cost.toFixed(2)} ~${String(Math.round(e.seconds / 60))}m` : ""}`;
		})
		.join("\n");
}

export function formatPick(result: Pick, kind: string, tier: string): string {
	const lines: string[] = [];
	const where = (o: Pick["ranked"][number]["offer"]) =>
		`effort=${o.effort} plan=${o.pool?.plan ?? "-"} pool=${o.pool?.id ?? "-"}${PLANS[o.pool?.plan ?? ""]?.overflow ? " (overflow)" : ""}`;

	if (result.tier === undefined) {
		lines.push(`no offer for ${tier}/${kind}: tier ${tier}, one up and one down are all empty`);
	} else {
		if (result.tier !== tier) {
			lines.push(`tier ${tier} empty, stepped to ${result.tier}`);
		}

		lines.push(`ranked (tier ${result.tier}/${kind}):`);

		result.ranked.forEach(({ offer: o, rank, evidence, source }, i) => {
			lines.push(
				`  ${String(i + 1)}. ${o.model} ${where(o)} rank=${rank.toFixed(2)} ${source === "table" ? "(table) " : ""}cov=${(evidence?.coverage ?? 0).toFixed(2)} n=0 host=${o.pool?.host.name ?? "-"} origin=${o.origin}`,
			);
		});
	}

	const selected = result.ranked[0];

	if (selected) {
		const { offer, evidence } = selected;
		const curve = [...result.ranked, ...result.excluded]
			.filter((r) => r.offer.model === offer.model && r.offer.pool === offer.pool)
			.toSorted((a, b) => EFFORTS.indexOf(a.offer.effort) - EFFORTS.indexOf(b.offer.effort));
		const at = curve.indexOf(selected);

		lines.push(
			`chosen: ${offer.model} effort=${offer.effort}${evidence?.signals.some((s) => s.kind === "interpolated") ? " (includes interpolated evidence)" : ""}`,
		);

		const signed = (value: number, digits = 3) =>
			`${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

		for (const neighbor of [curve[at - 1], curve[at + 1]]) {
			if (!neighbor) {
				continue;
			}

			const other = neighbor.evidence;

			if (!evidence || !other || selected.source !== "evidence" || neighbor.source !== "evidence") {
				lines.push(
					`  vs ${neighbor.offer.effort}: table fallback; insufficient evidence for a quality/cost/time comparison`,
				);

				continue;
			}

			const qualityGain = evidence.value * (evidence.p - other.p);
			const costDelta = evidence.cost - other.cost;
			const timeDelta = evidence.seconds - other.seconds;
			const utilityDelta = evidence.utility - other.utility;
			const reasons = result.excluded.find((r) => r === neighbor)?.reasons;

			lines.push(
				`  vs ${neighbor.offer.effort}: ΔQ=${signed(evidence.q - other.q)} quality-value=${signed(qualityGain)} task-cost=$${signed(costDelta)} pool-charge=${signed(evidence.lambda * 0.01 * costDelta)} time=${signed(timeDelta, 1)}s time-charge=${signed((evidence.latencyPerMinute * timeDelta) / 60)} ΔU=${signed(utilityDelta)}${reasons ? `; excluded: ${reasons.join("; ")}` : Math.abs(utilityDelta) < 1e-12 ? "; tied utility: prefer observed inputs, then lower effort" : "; quality gain versus cost and time"}`,
			);
		}

		if (selected.source === "evidence" && result.ranked.some((r) => r.source === "table")) {
			lines.push("  evidence-backed offers precede table-only fallback within the eligible tier");
		}
	}

	lines.push("excluded:");

	for (const { offer: o, reasons } of result.excluded) {
		lines.push(`  ${o.id} [${where(o)}]: ${reasons.join("; ")}`);
	}

	return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "refresh-codex") {
		const dir = `${homedir()}/.local/state/router`;
		const snapshot = await discoverCodex(dir, true).catch(() => undefined);

		await checkCodexAlerts(
			dir,
			snapshot,
			readJson<Catalog>(`${homedir()}/.claude/shared/model-tiers.json`),
		);

		if (!snapshot) {
			throw new Error("Codex catalog refresh incomplete");
		}

		return 0;
	}

	if (argv.length === 1 && argv[0] === "pull-evidence") {
		await discoverCodex(`${homedir()}/.local/state/router`);

		const pulled = spawnSync(
			"python3",
			[fileURLToPath(new URL("pull_evidence.py", import.meta.url))],
			{ stdio: "inherit" },
		);

		if (pulled.error) {
			process.stderr.write("route: cannot start python3 evidence puller\n");
		}

		return pulled.status ?? 1;
	}

	let parsed;

	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				for: { type: "string" },
				class: { type: "string" },
				"not-vendor": { type: "string", multiple: true },
				"allow-claude": { type: "boolean" },
				"allow-superseded": { type: "boolean" },
			},
		});
	} catch {
		process.stderr.write(`${USAGE}\n`);

		return 2;
	}

	const { values, positionals } = parsed;
	const [command, ...rest] = positionals;

	if (command === "run" && routeDepth() >= 4) {
		process.stderr.write("route: nesting limit reached (maximum 4)\n");

		return 4;
	}

	const kind = values.for ?? "code";
	const flagClass = values.class ?? "public";
	const selectsOffer = command === "run" || command === "why";
	const [target, ...words] = selectsOffer ? rest : [];
	// The task is whatever follows the model: a prompt, a file holding one, or "-" for stdin.
	const asked = words.join(" ");
	const briefFile = words.length === 1 && existsSync(asked) ? asked : undefined;
	const [model, effort] = (target ?? "").split(":");
	// Eli and Parker 2026-11-19: the agent chooses with repo context; route shows the menu, enforces, runs.
	const tier = "*";

	if (
		!["ls", "run", "why", "pace"].includes(command ?? "") ||
		(selectsOffer && !model) ||
		(command === "pace" && rest.length > 0) ||
		(command === "run" && !asked) ||
		(command !== "run" && values["allow-superseded"]) ||
		!KINDS.has(kind) ||
		(flagClass !== "public" && flagClass !== "sensitive" && flagClass !== "parcs")
	) {
		process.stderr.write(`${USAGE}\n`);

		return 2;
	}

	const brief =
		command === "run"
			? asked === "-"
				? { text: readFileSync(0, "utf8") }
				: briefFile
					? readBrief(briefFile)
					: { text: asked }
			: { text: "" };

	if ("text" in brief && command === "run" && !brief.text.trim()) {
		process.stderr.write(
			"route: the task is empty; aborting before any quota read or model call\n",
		);

		return 2;
	}

	if ("error" in brief) {
		process.stderr.write(`route: ${brief.error}; aborting before any quota read or model call\n`);

		return 2;
	}

	const home = homedir();
	const catalog = withCodexCatalog(
		readJson<Catalog>(`${home}/.claude/shared/model-tiers.json`),
		await discoverCodex(`${home}/.local/state/router`),
	);

	const dataClass = effectiveDataClass(flagClass, brief.text);
	const legacy = readJson<{ deny?: string[]; deny_patterns?: string[] }>(
		`${home}/.local/state/agy-build/pools.json`,
		{},
	);
	const config = sourceConfigFromEnv();
	const deps = defaultSourceDeps();
	const [google, codex, claude] = await Promise.all([
		readGoogleAi(config, deps),
		command === "pace" ? readPacingCodex() : readCodex(config, deps),
		readClaude(config, deps),
	]);
	const aa = readEvidence(`${home}/.claude/shared/aa-models.json`);
	const open = readOpenEvidence(`${home}/.local/state/router/evidence-open.json`);
	const state = {
		evidence: {
			rows: [...aa.rows, ...open.rows],
			unmapped: [...aa.unmapped.map((name) => `AA: ${name}`), ...open.unmapped],
			notes: [...aa.notes, ...open.notes],
		},
		nowMs: Date.now(),
		dataClass,
		// Eli 2026-11-19: "xhigh, max aren't allowed to be used by you".
		bannedEfforts: ["xhigh", "max", "ultra"],
		// Eli and Parker 2026-11-19: the caller picks from route's menu; route enforces and runs.
		choice: selectsOffer
			? {
					model: model ?? "",
					effort: effort === "" ? undefined : effort,
					allowSuperseded: values["allow-superseded"] === true,
				}
			: undefined,
		notVendor: (values["not-vendor"] ?? [])
			.flatMap((v) => v.split(","))
			.map((v) => v.trim().toLowerCase()),
		reports: { "google-ai": google, codex, claude },
		exhausted: readJson(`${home}/.local/state/agy-build/exhausted.json`, {}),
		deny: legacy.deny ?? [],
		denyPatterns: legacy.deny_patterns ?? [],
		pools: values["allow-claude"]
			? POOLS.map(({ explicitOnly: _explicit, ...pool }) => pool)
			: POOLS,
		blocks: BLOCKS,
		floorPct: Number(process.env["FLOOR"] ?? (command === "pace" ? 2 : 15)),
		runnableOnly: true,
		availability: await readAvailability(`${home}/.local/state/router`),
	};
	let result = pick(catalog, kind, tier, state);

	if (command === "pace") {
		process.stdout.write(`${await pace(`${home}/.local/state/router`, result, state.reports)}\n`);

		return 0;
	}

	// Parker 2026-11-19 ("I dont care. use the router"): when no other vendor can take the review,
	// fall back to the router's best different model, never the one that wrote the work.
	const parent = process.env["ROUTE_PARENT_MODEL"];

	if (
		parent &&
		result.ranked.length === 0 &&
		state.notVendor.length > 0 &&
		pick(catalog, kind, tier, { ...state, choice: undefined }).ranked.length === 0
	) {
		const fallback = { ...state, notVendor: [], notModel: [parent] };
		const alternatives = pick(catalog, kind, tier, { ...fallback, choice: undefined });

		if (alternatives.ranked.length > 0) {
			process.stdout.write(
				`no offer outside ${state.notVendor.join(",")}; falling back to the best different model (excluding ${parent})\n`,
			);

			Object.assign(state, fallback);
			result = state.choice ? pick(catalog, kind, tier, state) : alternatives;
		}
	}

	process.stdout.write(
		`${dataClass === flagClass ? "" : `class raised to ${dataClass} by the brief\n`}${redact(formatQuota(state.reports))}\n`,
	);

	if (command === "ls") {
		process.stdout.write(`${redact(formatMenu(result, kind))}\n`);

		return result.ranked.length > 0 ? 0 : 3;
	}

	if (command === "why" || result.ranked.length === 0) {
		process.stdout.write(`${redact(formatWhy(result, model ?? ""))}\n`);

		if (command === "why") {
			return result.ranked.length > 0 ? 0 : 3;
		}

		if (
			result.excluded.some((r) => r.supersededBy && !r.reasons.includes("not the caller's choice"))
		) {
			process.stdout.write("For reproducibility, rerun with --allow-superseded.\n");

			return 3;
		}

		const alternatives = pick(catalog, kind, tier, { ...state, choice: undefined }).ranked.slice(
			0,
			3,
		);

		process.stdout.write(
			`${target ?? ""} can't run now. Best runnable instead: ${alternatives.map((r) => `${r.offer.model}:${r.offer.effort}`).join(", ") || "none"}\n`,
		);

		return 3;
	}

	if (
		dataClass === "parcs" ||
		(command === "why" && result.ranked[0]?.offer.pool?.plan === "claude")
	) {
		const selected = result.ranked[0];
		const handoff = selected?.offer;
		// The ledger row is what lets the route guard admit the native Claude subagent.
		const runId = handoff && command === "run" ? crypto.randomUUID() : undefined;

		if (runId && handoff) {
			await appendEvent(`${home}/.local/state/router`, {
				event: "handoff",
				runId,
				model: handoff.model,
				effort: handoff.effort,
				plan: "claude",
				kind,
				dataClass,
				at: Date.now(),
				...(selected.supersededBy ? { supersessionOverride: selected.supersededBy } : {}),
			});
		}

		process.stdout.write(
			`Claude handoff: ${handoff ? `model=${handoff.model} effort=${handoff.effort}; ` : "no eligible effort; "}caller must launch explicitly on the claude plan${runId ? ` and put "ROUTED ${runId}" in the subagent prompt` : ""}; listed availability and policy exclusions still apply.\n`,
		);

		return 5;
	}

	if (command === "run") {
		const executed = await run({
			catalog,
			state,
			kind,
			tier,
			brief: brief.text,
			dataClass,
			briefName: briefFile ? path.basename(briefFile, ".md") : brief.text.trim().slice(0, 60),
			cwd: process.cwd(),
			dir: `${home}/.local/state/router`,
			legacy: `${home}/.local/state/agy-build`,
			// Only the real account notifies the session: tests that run under a temp HOME, or set
			// ROUTE_NO_INJECT=1, must not ping Janet with their fake runs.
			injectPath:
				process.env["ROUTE_NO_INJECT"] === "1" || home !== userInfo().homedir
					? "true"
					: `${process.env["HERMES_HOME"] ?? `${home}/.hermes`}/plugins/hermes-cc-link/bin/cc-link-inject`,
			report: (line) => process.stdout.write(`${redact(line)}\n`),
		});

		process.stdout.write(readFileSync(executed.outputPath, "utf8"));

		return executed.code;
	}

	return result.ranked.length > 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`route: ${error instanceof Error ? redact(error.message) : "failed"}\n`);
		process.exitCode = 1;
	}
}
