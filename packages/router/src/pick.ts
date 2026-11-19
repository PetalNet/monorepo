// Offer selection for `route pick`: every catalog model becomes an offer on a quota pool,
// hard rules drop offers (all reasons kept), and the survivors are ranked inside a tier band.
import type { ServiceName, ServiceReport } from "@petalnet/harness-hooks/quota-sources";

import { supportedEfforts, type Effort } from "./effort.ts";
import { evidenceKey, EFFORTS, scoreEvidence, type Evidence, type Score } from "./evidence.ts";
import type { Availability } from "./state.ts";

export type DataClass = "public" | "sensitive" | "parcs";
export type Vendor = "openai" | "google" | "anthropic";

export interface CatalogModel {
	id: string;
	provider: string;
	score: number;
	good?: Record<string, number>;
	pool?: string;
}

export interface Catalog {
	models: CatalogModel[];
	tiers: Record<string, number>;
}

export const PLANS: Record<string, { overflow?: true }> = { codex: { overflow: true } };

export interface Pool {
	id: string;
	plan: string;
	/** Quota source that reports this pool's windows; absent when nothing meters it. */
	service?: ServiceName;
	/** Quota limit ids this pool draws on. Any one under the floor takes the pool out. */
	windows: string[];
	host: { name: string; country: "us" | "cn" | "unknown" };
	trainsOnData: "yes" | "no" | "unknown";
	trainingSource?: string;
	explicitOnly?: true;
}

const GOOGLE = { name: "Google", country: "us" } as const;
const GOOGLE_POOL = {
	plan: "google-ai",
	service: "google-ai",
	host: GOOGLE,
	trainsOnData: "yes",
} as const;
const CLAUDE_POOL = {
	plan: "claude",
	service: "claude",
	host: { name: "Anthropic", country: "us" },
	trainsOnData: "no",
	trainingSource: "Parker 2026-11-19",
	explicitOnly: true,
} as const;

export const POOLS: Pool[] = [
	{
		...GOOGLE_POOL,
		id: "google-ai:gemini",
		windows: ["google-ai:gemini-models:5h", "google-ai:gemini-models:7d"],
	},
	// Unproven whether Argon also spends the Gemini 5h window; assume it does until a probe says otherwise.
	{
		...GOOGLE_POOL,
		id: "google-ai:argon",
		windows: ["google-ai:gemini-4-argon:7d", "google-ai:gemini-models:5h"],
	},
	{
		...GOOGLE_POOL,
		id: "google-ai:claude-gpt",
		windows: ["google-ai:claude-and-gpt-models:5h", "google-ai:claude-and-gpt-models:7d"],
	},
	{
		id: "codex",
		plan: "codex",
		service: "codex",
		windows: ["codex:5h", "codex:7d"],
		host: { name: "OpenAI", country: "us" },
		trainsOnData: "no",
		trainingSource: "Parker 2026-11-19",
	},
	{ ...CLAUDE_POOL, id: "claude", windows: ["claude:5h", "claude:7d"] },
	{ ...CLAUDE_POOL, id: "claude:fable", windows: ["claude:5h", "claude:7d", "claude:fable"] },
	{
		id: "ollama:local",
		plan: "ollama",
		windows: [],
		host: { name: "lab hardware", country: "us" },
		trainsOnData: "no",
	},
	{
		id: "ollama:cloud",
		plan: "ollama",
		windows: [],
		host: { name: "Ollama Cloud", country: "unknown" },
		trainsOnData: "unknown",
	},
];

export interface Block {
	family?: string;
	pool?: string;
	untilMs: number;
	why: string;
}

const FABLE_RESET_MS = Date.parse("2026-11-24T10:00:00Z"); // 04:00 America/Chicago, the Fable weekly reset

export const BLOCKS: Block[] = [
	{ family: "fable", untilMs: FABLE_RESET_MS, why: "Fable family blocked" },
	{ pool: "claude:fable", untilMs: FABLE_RESET_MS, why: "Fable pool blocked" },
];

export function familyOf(id: string): string {
	if (/^(?:claude-)?fable/u.test(id)) {
		return "fable";
	}

	if (/^(?:claude|opus|sonnet|haiku)/u.test(id)) {
		return "claude";
	}

	if (id.startsWith("gpt-oss")) {
		return "gpt-oss";
	}

	return /^[a-z]+/u.exec(id)?.[0] ?? id;
}

function vendorOf(family: string): Vendor | "other" | undefined {
	if (["gpt", "gpt-oss", "o", "codex"].includes(family)) {
		return "openai";
	}

	if (["gemini", "gemma"].includes(family)) {
		return "google";
	}

	if (["claude", "fable"].includes(family)) {
		return "anthropic";
	}

	if (["qwen", "kimi", "deepseek", "glm", "command"].includes(family)) {
		return "other";
	}

	return undefined;
}

/**
 * Where each family's maker is based. Shown, never filtered on: the host decides (see
 * offerReasons).
 */
const ORIGIN: Record<string, string> = {
	claude: "us",
	fable: "us",
	gemini: "us",
	gemma: "us",
	gpt: "us",
	"gpt-oss": "us",
	qwen: "cn",
	kimi: "cn",
	deepseek: "cn",
	glm: "cn",
	command: "ca",
};

/** Which pool a catalog model draws on: an explicit `pool` wins, else it follows from the provider. */
export function poolIdOf(m: CatalogModel): string | undefined {
	if (m.pool) {
		return m.pool;
	}

	if (m.provider === "gemini") {
		return m.id.startsWith("gemini-4-argon") ? "google-ai:argon" : "google-ai:gemini";
	}

	if (m.provider.startsWith("agy-")) {
		return "google-ai:claude-gpt";
	}

	if (m.provider === "claude") {
		return familyOf(m.id) === "fable" ? "claude:fable" : "claude";
	}

	if (m.provider === "local") {
		return m.id.includes("cloud") ? "ollama:cloud" : "ollama:local";
	}

	return m.provider === "codex" ? "codex" : undefined;
}

export interface Offer {
	id: string;
	provider: string;
	model: string;
	effort: Effort;
	family: string;
	origin: string;
	score: number;
	bonus: number;
	pool: Pool | undefined;
}

export function offersFrom(catalog: Catalog, kind: string, pools: Pool[]): Offer[] {
	const groups = new Map<string, CatalogModel>();

	for (const m of catalog.models) {
		const model = m.id.replace(/-(none|low|medium|high|xhigh|max)$/u, "");
		const key = `${m.provider}:${poolIdOf(m) ?? ""}:${evidenceKey(model, "default").model}`;
		const previous = groups.get(key);

		if (!previous || m.score > previous.score) {
			groups.set(key, m);
		}
	}

	return [...groups.values()].flatMap((m) => {
		const suffix = /-(none|low|medium|high|xhigh|max)$/u.exec(m.id)?.[1];
		const catalogEffort: Effort =
			suffix === "none" ||
			suffix === "low" ||
			suffix === "medium" ||
			suffix === "high" ||
			suffix === "xhigh" ||
			suffix === "max"
				? suffix
				: "default";
		const model = suffix ? m.id.slice(0, -suffix.length - 1) : m.id;
		const family = familyOf(m.id);

		return supportedEfforts(m.provider, model, catalogEffort).map((effort) => ({
			id:
				effort !== "default" && (m.provider === "gemini" || m.provider.startsWith("agy-"))
					? `${model}-${effort}`
					: model,
			provider: m.provider,
			model,
			effort,
			family,
			origin: ORIGIN[family] ?? "unknown",
			score: m.score,
			bonus: m.good?.[kind] ?? 0,
			pool: pools.find((p) => p.id === poolIdOf(m)),
		}));
	});
}

export interface State {
	notVendor?: Vendor;
	evidence?: Evidence;
	nowMs: number;
	dataClass: DataClass;
	reports: Partial<Record<ServiceName, ServiceReport>>;
	/** From exhausted.json: model id -> epoch seconds its limit resets. */
	exhausted: Record<string, number>;
	/** From pools.json: providers or model ids, and lowercase substrings of model ids. */
	deny: string[];
	denyPatterns: string[];
	pools: Pool[];
	blocks: Block[];
	floorPct: number;
	runnableOnly?: boolean;
	availability?: Availability;
}

interface PoolState {
	reasons: string[];
	headroom: number;
}

const clock = (ms: number) =>
	new Date(ms).toLocaleString("en-US", {
		timeZone: "America/Chicago",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

function matchesOfferId(offer: Offer, id: string): boolean {
	const suffix = /-(none|low|medium|high|xhigh|max)$/u.exec(id)?.[1];
	const model = suffix ? id.slice(0, -suffix.length - 1) : id;

	return (
		evidenceKey(model, "default").model === evidenceKey(offer.model, "default").model &&
		(!suffix || suffix === offer.effort)
	);
}

function poolState(pool: Pool, offers: Offer[], state: State): PoolState {
	const reasons: string[] = [];
	let headroom = 100;
	const report = pool.service ? state.reports[pool.service] : undefined;

	if (pool.service && !report) {
		reasons.push(`no quota reading for ${pool.service}`);
	}

	if (report && report.status !== "ok") {
		reasons.push(`${report.service} quota ${report.status}: ${report.summary}`);
	}

	const windows = report ? report.limits.filter((l) => pool.windows.includes(l.id)) : [];

	// A source that reports windows but none of this pool's has renamed them; don't read that as open.
	if (report && report.limits.length > 0 && windows.length === 0) {
		reasons.push(`no ${report.service} window matches this pool`);
	}

	for (const limit of windows) {
		const left = Math.max(0, 100 - limit.usedPct);

		headroom = Math.min(headroom, left);

		if (left < state.floorPct && !PLANS[pool.plan]?.overflow) {
			reasons.push(`${limit.id} ${String(left)}% left, resets ${limit.resetLabel ?? "?"}`);
		}
	}

	// One limit hit exhausts the whole pool, so a model-keyed entry cools every pool-mate.
	const hits = Object.entries(state.exhausted)
		.filter(
			([id, until]) =>
				until * 1000 > state.nowMs && offers.some((o) => o.pool === pool && matchesOfferId(o, id)),
		)
		.map(([id, until]) => ({ id, untilMs: until * 1000 }))
		.toSorted((a, b) => b.untilMs - a.untilMs);
	const last = hits[0];

	if (last) {
		reasons.push(
			`pool cooling down until ${clock(last.untilMs)} (${String(hits.length)} models hit limits, last ${last.id})`,
		);
	}

	return { reasons, headroom };
}

function offerReasons(o: Offer, pools: Map<Pool, PoolState>, state: State): string[] {
	if (!o.pool) {
		return ["no plan or pool serves this provider"];
	}

	const pool = o.pool;
	const reasons = [...(pools.get(pool)?.reasons ?? [])];

	if (
		state.runnableOnly &&
		!(
			o.provider === "codex" ||
			o.provider === "gemini" ||
			o.provider.startsWith("agy-") ||
			o.provider === "claude"
		)
	) {
		reasons.push("no execution adapter");
	}

	if ((state.availability?.cooldowns[pool.id] ?? 0) > state.nowMs) {
		reasons.push("pool cooling down");
	}

	if (
		Object.entries(state.availability?.badOffers ?? {}).some(
			([key, until]) =>
				until > state.nowMs &&
				key.startsWith(`${pool.plan}:`) &&
				matchesOfferId(o, key.slice(pool.plan.length + 1)),
		)
	) {
		reasons.push("offer invalid for 24h");
	}

	if (state.availability?.signedOut[pool.plan]) {
		reasons.push("plan signed out");
	}

	for (const b of state.blocks) {
		if (b.untilMs > state.nowMs && (b.family === o.family || b.pool === pool.id)) {
			reasons.push(`${b.why} until ${clock(b.untilMs)}`);
		}
	}

	if (state.notVendor) {
		const vendor = vendorOf(o.family);

		if (!vendor) {
			reasons.push("model maker unknown for vendor exclusion");
		} else if (vendor === state.notVendor) {
			reasons.push(`excluded maker: ${vendor}`);
		}
	}

	if (pool.explicitOnly && state.dataClass !== "parcs") {
		reasons.push(`${pool.plan} plan is explicit-use only`);
	}

	const id = o.id.toLowerCase();

	if (
		state.deny.some((denied) => matchesOfferId(o, denied)) ||
		state.deny.includes(o.provider) ||
		state.denyPatterns.some((p) => id.includes(p))
	) {
		reasons.push("denied in pools.json");
	}

	if (o.score <= 0) {
		reasons.push("unscored");
	}

	if (state.dataClass === "parcs" && pool.plan !== "claude") {
		reasons.push("parcs brief: claude plan only");
	}

	if (state.dataClass !== "public") {
		if (pool.host.country !== "us") {
			reasons.push(
				`sensitive brief: host ${pool.host.name} is in ${pool.host.country === "cn" ? "China" : "an unknown country"}`,
			);
		}

		if (pool.trainsOnData !== "no") {
			reasons.push(
				`sensitive brief: ${pool.host.name} ${pool.trainsOnData === "yes" ? "trains on our data" : "training opt-out unverified"}`,
			);
		}
	}

	return reasons;
}

export interface Ranked {
	offer: Offer;
	rank: number;
	evidence?: Score;
	source?: "evidence" | "table";
}

export interface Pick {
	tier: string | undefined;
	ranked: Ranked[];
	excluded: (Ranked & { reasons: string[] })[];
}

/** Ranks offers in the requested tier band; if the band is empty, tries one tier up, then one down. */
export function pick(catalog: Catalog, kind: string, tier: string, state: State): Pick {
	const offers = offersFrom(catalog, kind, state.pools);
	const pools = new Map(state.pools.map((p) => [p, poolState(p, offers, state)]));
	const judged = offers.map((offer) => ({ offer, reasons: offerReasons(offer, pools, state) }));
	const order = Object.entries(catalog.tiers).toSorted((a, b) => b[1] - a[1]);
	const at = order.findIndex(([t]) => t === tier);
	const tries = [order[at], order[at - 1], order[at + 1]].filter((t) => t !== undefined);
	const band = (t: string) => {
		const i = order.findIndex(([name]) => name === t);
		const lo = order[i]?.[1] ?? 0;

		return [lo, order[i - 1]?.[1] ?? Infinity] as const;
	};

	const chosen = tries.find(([t]) => {
		const [lo, hi] = band(t);

		return judged.some((j) => j.reasons.length === 0 && j.offer.score >= lo && j.offer.score < hi);
	})?.[0];
	const [lo, hi] = band(chosen ?? tier);
	const ranked: Ranked[] = [];
	const excluded: Pick["excluded"] = [];

	for (const j of judged) {
		const inBand = j.offer.score >= lo && j.offer.score < hi;

		const headroom = j.offer.pool ? (pools.get(j.offer.pool)?.headroom ?? 100) : 0;

		const evidence = state.evidence
			? scoreEvidence(state.evidence, j.offer.model, j.offer.effort, kind, state.nowMs, headroom)
			: undefined;
		const useEvidence = evidence !== undefined && evidence.coverage + 1e-12 >= 0.3;
		// Convert the historical index to the same 0..1 quality scale for mixed rankings.
		const tableRank = j.offer.score + j.offer.bonus + headroom / 1000;
		const rank = state.evidence
			? useEvidence
				? evidence.utility
				: (kind === "sweep" ? 1 : 10) * (0.45 + 0.47 * Math.min(1, tableRank / 100))
			: tableRank;

		const assessed: Ranked = {
			offer: j.offer,
			rank,
			...(evidence ? { evidence } : {}),
			source: useEvidence ? "evidence" : "table",
		};

		if (j.reasons.length === 0 && inBand) {
			ranked.push(assessed);
		} else {
			const reasons = inBand
				? j.reasons
				: [...j.reasons, `score ${String(j.offer.score)} outside tier ${chosen ?? tier}`];

			excluded.push({ ...assessed, reasons });
		}
	}

	ranked.sort(
		(a, b) =>
			Number(b.source === "evidence") - Number(a.source === "evidence") ||
			b.rank - a.rank ||
			// Prefer directly observed inputs when utility ties an endpoint interpolation.
			(a.evidence?.signals.filter((s) => s.kind === "interpolated").length ?? 0) -
				(b.evidence?.signals.filter((s) => s.kind === "interpolated").length ?? 0) ||
			EFFORTS.indexOf(a.offer.effort) - EFFORTS.indexOf(b.offer.effort),
	);

	return { tier: chosen, ranked, excluded };
}
