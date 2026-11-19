import { basename } from "node:path";
// route: pick a builder offer (model, effort, plan, pool) for a brief from live quota state.
//
//   route pick --dry --kind <code|ui|research|write|sweep|cyber|architecture> --tier <S|A|B|C|top|mid|fast|cheap>
//              --data-class <public|sensitive|parcs> <brief-file>
//
// Exit codes: 0 completed/picked, 1 failed, 2 bad input, 3 no eligible offer, 5 Claude handoff.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	defaultSourceDeps,
	readClaude,
	readCodex,
	readGoogleAi,
	sourceConfigFromEnv,
} from "@petalnet/harness-hooks/quota-sources";

import { redact } from "./adapters.ts";
import { evidenceKey, EFFORTS, halfLifeDays, readEvidence } from "./evidence.ts";
import { readOpenEvidence } from "./open-evidence.ts";
import {
	BLOCKS,
	POOLS,
	PLANS,
	type Catalog,
	type DataClass,
	type Pick,
	offersFrom,
	pick,
} from "./pick.ts";
import { run } from "./run.ts";
import { readAvailability } from "./state.ts";

const USAGE =
	"usage: route pull-evidence | route <pick --dry|explain|run> --kind <code|ui|research|write|sweep|cyber|architecture> --tier <S|A|B|C|top|mid|fast|cheap> --data-class <public|sensitive|parcs> <brief-file for pick; brief text for run>";
const TIER_ALIASES: Record<string, string> = { top: "S", mid: "A", fast: "B", cheap: "C" };
const KINDS = new Set(["code", "ui", "research", "write", "sweep", "cyber", "architecture"]);
const SECRET_RE =
	/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/u;

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

/** A brief carrying a credential is sensitive whatever the flag says; the class only ever rises. */
export function effectiveDataClass(flag: DataClass, brief: string): DataClass {
	if (flag === "parcs" || /\b(?:PARCS|Bridgeton)\b/iu.test(brief)) {
		return "parcs";
	}

	return SECRET_RE.test(brief) ? "sensitive" : flag;
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
	if (argv.length === 1 && argv[0] === "pull-evidence") {
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
				dry: { type: "boolean" },
				"allow-claude": { type: "boolean" },
				"not-vendor": { type: "string", multiple: true },
				kind: { type: "string" },
				tier: { type: "string" },
				"data-class": { type: "string" },
			},
		});
	} catch {
		process.stderr.write(`${USAGE}\n`);

		return 2;
	}

	const { values, positionals } = parsed;
	const [command, briefFile] = positionals;
	const { kind = "" } = values;
	const tier = TIER_ALIASES[values.tier ?? ""] ?? values.tier ?? (command === "explain" ? "S" : "");
	const flagClass = values["data-class"] ?? (command === "explain" ? "public" : undefined);

	if (
		(command !== "pick" && command !== "run" && command !== "explain") ||
		(command === "pick" && !values.dry) ||
		(command === "run" && values.dry) ||
		!KINDS.has(kind) ||
		!tier ||
		(flagClass !== "public" && flagClass !== "sensitive" && flagClass !== "parcs")
	) {
		process.stderr.write(`${USAGE}\n`);

		return 2;
	}

	const brief = command === "run" ? { text: positionals.slice(1).join(" ") } : readBrief(briefFile);

	if ("text" in brief && !brief.text.trim()) {
		return 2;
	}

	if ("error" in brief) {
		process.stderr.write(`route: ${brief.error}; aborting before any quota read or model call\n`);

		return 2;
	}

	const home = homedir();
	const catalog = readJson<Catalog>(`${home}/.claude/shared/model-tiers.json`);

	if (!(tier in catalog.tiers)) {
		process.stderr.write(`route: unknown tier ${tier}\n`);

		return 2;
	}

	const dataClass = effectiveDataClass(flagClass, brief.text);
	const legacy = readJson<{ deny?: string[]; deny_patterns?: string[] }>(
		`${home}/.local/state/agy-build/pools.json`,
		{},
	);
	const config = sourceConfigFromEnv();
	const deps = defaultSourceDeps();
	const [google, codex, claude] = await Promise.all([
		readGoogleAi(config, deps),
		readCodex(config, deps),
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
		notVendor: (values["not-vendor"] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase()),
		reports: { "google-ai": google, codex, claude },
		exhausted: readJson(`${home}/.local/state/agy-build/exhausted.json`, {}),
		deny: legacy.deny ?? [],
		denyPatterns: legacy.deny_patterns ?? [],
		pools: values["allow-claude"]
			? POOLS.map(({ explicitOnly: _explicit, ...pool }) => pool)
			: POOLS,
		blocks: BLOCKS,
		floorPct: Number(process.env["FLOOR"] ?? 15),
		runnableOnly: command === "run",
		availability: await readAvailability(`${home}/.local/state/router`),
	};
	const result = pick(catalog, kind, tier, state);

	process.stdout.write(
		`route ${command}${command === "pick" ? " --dry" : ""} kind=${kind} tier=${tier} data-class=${dataClass}${dataClass === flagClass ? "" : " (raised by brief policy)"}\n`,
	);

	process.stdout.write(`${redact(formatPick(result, kind, tier))}\n`);

	if (command === "explain") {
		process.stdout.write(
			`${state.evidence.notes.join("\n")}\nUnmapped source names: ${state.evidence.unmapped.join(", ")}\n`,
		);

		const unmapped = offersFrom(catalog, kind, state.pools).filter(
			(offer) =>
				!state.evidence.rows.some(
					(row) => row.model === evidenceKey(offer.model, offer.effort).model,
				),
		);

		process.stdout.write(
			`Catalog models without evidence: ${[...new Set(unmapped.map((offer) => offer.model))].join(", ")}\n`,
		);

		const candidates = [
			...result.ranked,
			...result.excluded.map((row) => ({
				...row,
				source: `${row.source ?? "table"}; excluded (${row.reasons.join("; ")})`,
			})),
		].toSorted((a, b) => b.rank - a.rank);

		for (const row of candidates) {
			const score = row.evidence;

			if (!score) {
				continue;
			}

			process.stdout.write(
				`${row.offer.id} evidence-effort=${evidenceKey(row.offer.model, row.offer.effort).effort}: ${row.source ?? "table"} cov=${score.coverage.toFixed(2)} use=${score.coverage + 1e-12 >= 0.3 ? "evidence" : "table"} rank=${row.rank.toFixed(3)} Q=${score.q.toFixed(3)} p=${score.p.toFixed(3)} evidence-U=${score.utility.toFixed(3)} lambda=${score.lambda.toFixed(3)} cost=$${score.cost.toFixed(3)} latency=${score.seconds.toFixed(1)}s tokens=${score.tokens.toFixed(0)} speed=${score.speed.toFixed(1)}/s TTFT=${score.ttft.toFixed(1)}s table=${String(row.offer.score)}\n`,
			);

			process.stdout.write(
				`  ${score.signals.map((s) => `${s.signal}=${s.value.toFixed(3)} [${s.kind}; ${s.src}; effort=${s.effort}; reporter=${s.reporter ?? s.src}; half-life=${String(halfLifeDays(s))}d; ${s.asof}; ${s.url}]`).join("\n  ")}\n  missing: ${score.missing.join(", ")}\n  ${score.assumptions.join("; ")}\n`,
			);

			for (const s of score.crossChecks) {
				process.stdout.write(
					`  cross-check (unweighted): ${s.signal}=${s.value.toFixed(3)} [${s.kind}; ${s.src}; effort=${s.effort}; reporter=${s.reporter ?? s.src}; half-life=${String(halfLifeDays(s))}d; ${s.asof}; ${s.url}]\n`,
				);
			}
		}
	}

	if (
		dataClass === "parcs" ||
		(command !== "run" && result.ranked[0]?.offer.pool?.plan === "claude")
	) {
		const handoff = result.ranked[0]?.offer;

		process.stdout.write(
			`Claude handoff: ${handoff ? `model=${handoff.model} effort=${handoff.effort}; ` : "no eligible effort; "}caller must launch explicitly on the claude plan; listed availability and policy exclusions still apply.\n`,
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
			briefName: /^\S+\.md$/u.test(brief.text.trim()) ? basename(brief.text.trim(), ".md") : "",
			cwd: process.cwd(),
			dir: `${home}/.local/state/router`,
			legacy: `${home}/.local/state/agy-build`,
			injectPath: `${process.env["HERMES_HOME"] ?? `${home}/.hermes`}/plugins/hermes-cc-link/bin/cc-link-inject`,
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
