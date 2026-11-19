// route: pick a builder offer (model, effort, plan, pool) for a brief from live quota state.
//
//   route pick --dry --kind <code|ui|research|write|sweep> --tier <S|A|B|C|top|mid|fast|cheap>
//              --data-class <public|sensitive> <brief-file>
//
// Exit codes: 0 picked, 2 bad input (nothing read), 3 no offer survives the hard rules.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	defaultSourceDeps,
	readClaude,
	readCodex,
	readGoogleAi,
	sourceConfigFromEnv,
} from "@petalnet/harness-hooks/quota-sources";

import { BLOCKS, POOLS, type Catalog, type DataClass, type Pick, pick } from "./pick.ts";

const USAGE =
	"usage: route pick --dry --kind <code|ui|research|write|sweep> --tier <S|A|B|C|top|mid|fast|cheap> --data-class <public|sensitive> <brief-file>";
const TIER_ALIASES: Record<string, string> = { top: "S", mid: "A", fast: "B", cheap: "C" };
const KINDS = new Set(["code", "ui", "research", "write", "sweep"]);
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
	return SECRET_RE.test(brief) ? "sensitive" : flag;
}

export function formatPick(result: Pick, kind: string, tier: string): string {
	const lines: string[] = [];
	const where = (o: Pick["ranked"][number]["offer"]) =>
		`effort=${o.effort} plan=${o.pool?.plan ?? "-"} pool=${o.pool?.id ?? "-"}`;

	if (result.tier === undefined) {
		lines.push(`no offer for ${tier}/${kind}: tier ${tier}, one up and one down are all empty`);
	} else {
		if (result.tier !== tier) {
			lines.push(`tier ${tier} empty, stepped to ${result.tier}`);
		}

		lines.push(`ranked (tier ${result.tier}/${kind}):`);

		result.ranked.forEach(({ offer: o, rank }, i) => {
			lines.push(
				`  ${String(i + 1)}. ${o.model} ${where(o)} rank=${rank.toFixed(2)} host=${o.pool?.host.name ?? "-"} origin=${o.origin}`,
			);
		});
	}

	lines.push("excluded:");

	for (const { offer: o, reasons } of result.excluded) {
		lines.push(`  ${o.id} [${where(o)}]: ${reasons.join("; ")}`);
	}

	return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
	let parsed;

	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				dry: { type: "boolean" },
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
	const tier = TIER_ALIASES[values.tier ?? ""] ?? values.tier ?? "";
	const flagClass = values["data-class"];

	if (
		command !== "pick" ||
		!values.dry ||
		!KINDS.has(kind) ||
		!tier ||
		(flagClass !== "public" && flagClass !== "sensitive")
	) {
		process.stderr.write(`${USAGE}\n(only --dry exists in this slice; route run comes next)\n`);

		return 2;
	}

	const brief = readBrief(briefFile);

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
	const result = pick(catalog, kind, tier, {
		nowMs: Date.now(),
		dataClass,
		reports: { "google-ai": google, codex, claude },
		exhausted: readJson(`${home}/.local/state/agy-build/exhausted.json`, {}),
		deny: legacy.deny ?? [],
		denyPatterns: legacy.deny_patterns ?? [],
		pools: POOLS,
		blocks: BLOCKS,
		floorPct: Number(process.env["FLOOR"] ?? 15),
	});

	process.stdout.write(
		`route pick --dry kind=${kind} tier=${tier} data-class=${dataClass}${dataClass === flagClass ? "" : " (raised: brief holds a credential)"}\n`,
	);

	process.stdout.write(`${formatPick(result, kind, tier)}\n`);

	return result.ranked.length > 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`route: ${error instanceof Error ? error.message : "failed"}\n`);
		process.exitCode = 1;
	}
}
