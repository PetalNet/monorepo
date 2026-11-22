import { readFileSync } from "node:fs";

export interface EvidenceRow {
	model: string;
	effort: string;
	signal: string;
	value: number;
	src: string;
	kind: "measured" | "vendor" | "interpolated" | "family-prior";
	asof: string;
	url: string;
	reporter?: string;
	halfLifeDays?: number;
}
export interface Evidence {
	rows: EvidenceRow[];
	unmapped: string[];
	notes: string[];
}

const ALIASES: Record<string, string> = {
	"gemini-4-neon": "gemini-4-neon",
	"gemini-4-hydrogen": "gemini-4-hydrogen",
	"gemini-4-argon": "gemini-4-argon",
	"gemini-3-8-flash": "gemini-3.8-flash",
	"gpt-6-astra": "gpt-6-astra",
	"gpt-6-sol": "gpt-6-sol",
	"gpt-6-luna": "gpt-6-luna",
	"gpt-6-1-sol": "gpt-6.1-sol",
	"gpt-6-1-terra": "gpt-6.1-terra",
	"gpt-oss-120b": "gpt-oss-120b",
	"claude-opus-5-5": "claude-opus-5-5",
	"claude-sonnet-5-5": "claude-sonnet-5-5",
	"claude-haiku-5-5": "claude-haiku-5-5",
	"claude-fable-5-2": "claude-fable-5-2",
};

export function evidenceKey(model: string, effort: string): { model: string; effort: string } {
	const aliases: Record<string, string> = {
		opus: "claude-opus-5-5",
		sonnet: "claude-sonnet-5-5",
		haiku: "claude-haiku-5-5",
		fable: "claude-fable-5-2",
	};

	return {
		model: aliases[model] ?? model,
		effort: effort === "default" ? (model.startsWith("gpt-") ? "medium" : "max") : effort,
	};
}

function field(raw: unknown, key: string): unknown {
	let value = raw;

	for (const part of key.split(".")) {
		if (!value || typeof value !== "object") {
			return undefined;
		}

		value = Reflect.get(value, part);
	}

	return value;
}

function flatten(raw: unknown, prefix = ""): [string, number][] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return [];
	}

	return Object.entries(raw).flatMap(([key, value]) => {
		const name = prefix ? `${prefix}.${key}` : key;

		return typeof value === "number" && Number.isFinite(value)
			? [[name, value]]
			: flatten(value, name);
	});
}

export function normalizeAA(raw: unknown): Evidence {
	const models = field(raw, "models");

	if (!Array.isArray(models)) {
		throw new TypeError("AA evidence has no models array");
	}

	const result: Evidence = {
		rows: [],
		unmapped: [],
		notes: [
			"Artificial Analysis: https://artificialanalysis.ai; asof is fetch time, not evaluation time",
			"Effort labels matched by name; harness equivalence remains unverified",
		],
	};

	for (const record of models) {
		const slug = field(record, "slug");
		const release = field(record, "release.slug");
		const effort =
			field(record, "effort.slug") ??
			(typeof slug === "string" && slug.endsWith("-non-reasoning") ? "none" : undefined);
		const asof = field(record, "fetchedAt") ?? field(raw, "fetchedAt");
		const model =
			typeof release === "string"
				? (ALIASES[release] ??
					(/^gpt-\d+(?:[.-]\d+)?-[a-z]+$/u.test(release)
						? release.replace(/^(gpt-\d+)-(\d+)-/u, "$1.$2-")
						: undefined))
				: undefined;

		if (
			typeof slug !== "string" ||
			!model ||
			typeof effort !== "string" ||
			!EFFORTS.includes(effort)
		) {
			result.unmapped.push(typeof slug === "string" ? slug : "invalid record");

			continue;
		}

		if (typeof asof !== "string" || !Number.isFinite(Date.parse(asof))) {
			throw new TypeError("AA evidence has invalid fetchedAt");
		}

		for (const [signal, value] of flatten(record)) {
			result.rows.push({
				model,
				effort,
				signal,
				value,
				src: "AA",
				kind: signal.startsWith("price") || signal === "cacheHitPrice" ? "vendor" : "measured",
				asof,
				url: `https://artificialanalysis.ai/models/${slug}`,
			});
		}
	}

	return result;
}

export function readEvidence(file: string): Evidence {
	try {
		return normalizeAA(JSON.parse(readFileSync(file, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { rows: [], unmapped: [], notes: ["AA file absent; table fallback"] };
		}

		throw error;
	}
}

// Keep unsupported independent signals in the denominator: absence must reduce coverage.
// TerminalBench 4.1 duplicates 4.0; SWE-bench Pro is stale. Neither receives a second vote.
export const PROFILES: Record<string, Record<string, number>> = {
	code: { terminalBench40: 0.4, frontierCode20: 0.4, intelligenceIndex: 0.1, arena_webdev: 0.1 },
	ui: {
		arena_webdev: 0.35,
		design_arena: 0.35,
		code2videoElo: 0.1,
		frontierCode20: 0.1,
		mmmuPro: 0.1,
	},
	write: {
		arena_creative: 0.25,
		arena_text: 0.1,
		eqbench_creative_v3: 0.2,
		eqbench4: 0.05,
		"personalityBench.scores.slop": 0.07,
		"personalityBench.scores.direct": 0.06,
		"personalityBench.scores.informationDense": 0.07,
		"briefcaseBreakdown.overall.elo": 0.1,
		gdpval: 0.1,
	},
	research: {
		hleDiamond: 0.25,
		omniscienceAccuracy: 0.25,
		omniscienceHallucinationRate: 0.2,
		gdpval: 0.15,
		terminalBenchScience: 0.15,
	},
	architecture: {
		intelligenceIndex: 0.25,
		frontierCode20: 0.2,
		"briefcaseBreakdown.overall.elo": 0.2,
		lcr: 0.15,
		metr_horizon: 0.1,
		omniscienceHallucinationRate: 0.1,
	},
	sweep: { automationBenchPartialScore: 0.5, tau2: 0.25, terminalBench40: 0.25 },
	cyber: {
		aa_cyber_index: 0.7,
		cybergym: 0.15,
		cybench: 0.15,
	},
};
// Curve estimates retain their measurements' weight: discounting only an interior point can
// pull it toward a stronger family prior and invent a quality gain over both endpoints.
const RELIABILITY = { measured: 1, vendor: 0.6, interpolated: 1, "family-prior": 0.3 };

export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

const lower = (signal: string) =>
	signal === "omniscienceHallucinationRate" || signal === "personalityBench.scores.slop";
const family = (model: string) => model.split("-")[0] ?? model;

export function median(values: number[]): number | undefined {
	const sorted = values.toSorted((a, b) => a - b);
	const i = Math.floor(sorted.length / 2);

	return sorted.length > 0
		? ((sorted[i] ?? 0) + (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0)) / 2
		: undefined;
}

export function resolveSignal(
	rows: EvidenceRow[],
	model: string,
	effort: string,
	signal: string,
): EvidenceRow | undefined {
	const candidates = rows.filter((r) => r.signal === signal);
	const exact = candidates
		.filter((r) => r.model === model && r.effort === effort)
		.toSorted(
			(a, b) =>
				RELIABILITY[b.kind] - RELIABILITY[a.kind] || Date.parse(b.asof) - Date.parse(a.asof),
		)[0];

	if (exact) {
		return exact;
	}

	// Upstream's unspecified effort is model-level evidence, never an effort alias.
	const modelLevel = candidates
		.filter((r) => r.model === model && r.effort === "unspecified")
		.toSorted(
			(a, b) =>
				RELIABILITY[b.kind] - RELIABILITY[a.kind] || Date.parse(b.asof) - Date.parse(a.asof),
		)[0];

	const at = EFFORTS.indexOf(effort);
	const measured = EFFORTS.flatMap((level) => {
		const row = candidates
			.filter((r) => r.model === model && r.kind === "measured" && r.effort === level)
			.toSorted((a, b) => Date.parse(b.asof) - Date.parse(a.asof))[0];

		return row ? [row] : [];
	});
	const lo = measured
		.filter((r) => EFFORTS.indexOf(r.effort) < at)
		.toSorted((a, b) => EFFORTS.indexOf(b.effort) - EFFORTS.indexOf(a.effort))[0];
	const hi = measured
		.filter((r) => EFFORTS.indexOf(r.effort) > at)
		.toSorted((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort))[0];

	if (at !== -1 && lo && hi) {
		const fraction =
			(at - EFFORTS.indexOf(lo.effort)) / (EFFORTS.indexOf(hi.effort) - EFFORTS.indexOf(lo.effort));

		return {
			...lo,
			effort,
			value: lo.value + fraction * (hi.value - lo.value),
			kind: "interpolated",
			src: `${lo.src} interpolation ${lo.effort}..${hi.effort}`,
			asof: lo.asof < hi.asof ? lo.asof : hi.asof,
		};
	}

	const endpoint = lo ?? hi;

	if (at !== -1 && endpoint) {
		return {
			...endpoint,
			effort,
			kind: "interpolated",
			src: `${endpoint.src} interpolation clamped to ${endpoint.effort} (outside measured curve)`,
		};
	}

	if (modelLevel) {
		return modelLevel;
	}

	const peers = candidates.filter(
		(r) => family(r.model) === family(model) && r.kind === "measured",
	);
	const value = median(peers.map((r) => r.value));
	const first = peers.toSorted((a, b) => Date.parse(a.asof) - Date.parse(b.asof))[0];

	return first && value !== undefined
		? {
				...first,
				model,
				effort,
				value,
				kind: "family-prior",
				src: `${first.src} ${family(model)} median`,
			}
		: undefined;
}

export function percentile(rows: EvidenceRow[], row: EvidenceRow): number {
	const values = rows
		.filter((r) => r.signal === row.signal && r.kind === "measured")
		.map((r) => r.value);

	if (values.length === 0) {
		return 0.5;
	}

	const p =
		(values.filter((v) => v < row.value).length +
			0.5 * values.filter((v) => v === row.value).length) /
		values.length;

	return lower(row.signal) ? 1 - p : p;
}

export interface Score {
	q: number;
	coverage: number;
	p: number;
	utility: number;
	lambda: number;
	cost: number;
	seconds: number;
	tokens: number;
	speed: number;
	ttft: number;
	value: number;
	latencyPerMinute: number;
	signals: EvidenceRow[];
	crossChecks: EvidenceRow[];
	missing: string[];
	assumptions: string[];
}

export function scoreEvidence(
	evidence: Evidence,
	model: string,
	effort: string,
	kind: string,
	now: number,
	headroom: number,
): Score {
	const key = evidenceKey(model, effort);
	const profile = PROFILES[kind] ?? {};
	const total = Object.values(profile).reduce((a, b) => a + b, 0) || 1;
	let denominator = 0,
		numerator = 0,
		present = 0;
	const missing: string[] = [];
	const signals: EvidenceRow[] = [];
	let familyQuality = 0;

	for (const [signal, weight] of Object.entries(profile)) {
		const row = resolveSignal(evidence.rows, key.model, key.effort, signal);

		if (!row) {
			missing.push(signal);
			familyQuality += weight * 0.5;

			continue;
		}

		signals.push(row);

		// A family prior is regularization, not observed coverage of this offer.
		if (row.kind !== "family-prior") {
			present += weight;
		}

		const confidence =
			RELIABILITY[row.kind] *
			0.5 ** (Math.max(0, now - Date.parse(row.asof)) / 86400000 / halfLifeDays(row));

		numerator += weight * confidence * percentile(evidence.rows, row);
		denominator += weight * confidence;

		const relatives = evidence.rows.filter(
			(r) => r.signal === signal && family(r.model) === family(key.model) && r.kind === "measured",
		);

		familyQuality += weight * (median(relatives.map((r) => percentile(evidence.rows, r))) ?? 0.5);
	}

	const k0 = 0.15 * total;
	const q = (numerator + k0 * (familyQuality / total)) / (denominator + k0);
	const value = kind === "sweep" ? 1 : 10;
	const latencyPerMinute = kind === "sweep" ? 0.2 : 0.05;
	const assumptions = [
		"n=0; uncalibrated p0=.45+.47Q",
		`M task: 12000 output tokens at catalog median; V=${String(value)}; latency=${String(latencyPerMinute)}/min (routine sweep favors turnaround)`,
		"pool fraction proxy=.01 × task dollars; pace unknown, rho=1",
	];

	if (signals.some((row) => row.effort === "unspecified")) {
		assumptions.push(
			"unspecified effort: model-level coverage only; no claim of effort/harness equivalence",
		);
	}

	const crossCheckSignals =
		kind === "cyber"
			? ["aa_cwe_bench", "aa_deepsec_bench", "aa_cybergym_e2e"]
			: kind === "code" || kind === "architecture" || kind === "research"
				? ["epoch_gpqa", "epoch_mirrorcode", "epoch_swe_verified"]
				: [];
	const crossChecks = crossCheckSignals.flatMap((signal) => {
		const row = resolveSignal(evidence.rows, key.model, key.effort, signal);

		return row && row.kind !== "family-prior" ? [row] : [];
	});
	const metric = (signal: string, fallback: number) => {
		const row = resolveSignal(evidence.rows, key.model, key.effort, signal);

		if (row) {
			signals.push(row);

			return row.value;
		}

		assumptions.push(`${signal} missing: neutral default ${String(fallback)}`);

		return fallback;
	};

	const tokenSignal = "intelligenceIndexOutputTokensPerTask.output";
	const baseline =
		median(evidence.rows.filter((r) => r.signal === tokenSignal).map((r) => r.value)) ?? 12000;
	const tokens = metric(tokenSignal, baseline);
	const scale = 12000 / baseline;
	const cost = Math.max(0, metric("intelligenceIndexCostPerTask.cost.total", 1) * scale);
	const speed = metric("headline.outputSpeed", 50);
	const ttft = Math.max(0, metric("headline.timeToFirstToken", 2));
	const seconds = ttft + (tokens * scale) / Math.max(1, speed);
	const lambda = 0.5 + 2 * (1 - Math.min(100, Math.max(0, headroom)) / 100) ** 2;
	const p = 0.45 + 0.47 * q;

	return {
		q,
		coverage: present / total,
		p,
		utility: value * p - lambda * 0.01 * cost - (latencyPerMinute * seconds) / 60,
		lambda,
		cost,
		seconds,
		tokens: tokens * scale,
		speed,
		ttft,
		value,
		latencyPerMinute,
		signals,
		crossChecks,
		missing,
		assumptions,
	};
}

export function halfLifeDays(row: EvidenceRow): number {
	return (
		row.halfLifeDays ??
		(row.kind === "vendor"
			? 365
			: ["Arena", "DesignArena", "EQ-Bench"].includes(row.src)
				? 90
				: 180)
	);
}
