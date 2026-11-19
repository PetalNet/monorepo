// Offer selection for `route pick`: every catalog model becomes an offer on a quota pool,
// hard rules drop offers (all reasons kept), and the survivors are ranked inside a tier band.
import type { ServiceName, ServiceReport } from "@petalnet/harness-hooks/quota-sources";

export type DataClass = "public" | "sensitive";

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

export interface Pool {
	id: string;
	plan: string;
	/** Quota source that reports this pool's windows; absent when nothing meters it. */
	service?: ServiceName;
	/** Quota limit ids this pool draws on. Any one under the floor takes the pool out. */
	windows: string[];
	host: { name: string; country: "us" | "cn" | "unknown" };
	trainsOnData: "yes" | "no" | "unknown";
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
	trainsOnData: "unknown",
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
		trainsOnData: "unknown",
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
	effort: string;
	family: string;
	origin: string;
	score: number;
	bonus: number;
	pool: Pool | undefined;
}

export function offersFrom(catalog: Catalog, kind: string, pools: Pool[]): Offer[] {
	return catalog.models.map((m) => {
		const effort = /-(low|medium|high|xhigh|max)$/u.exec(m.id)?.[1];
		const family = familyOf(m.id);

		return {
			id: m.id,
			provider: m.provider,
			model: effort ? m.id.slice(0, -effort.length - 1) : m.id,
			effort: effort ?? "default",
			family,
			origin: ORIGIN[family] ?? "unknown",
			score: m.score,
			bonus: m.good?.[kind] ?? 0,
			pool: pools.find((p) => p.id === poolIdOf(m)),
		};
	});
}

export interface State {
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

		if (left < state.floorPct) {
			reasons.push(`${limit.id} ${String(left)}% left, resets ${limit.resetLabel ?? "?"}`);
		}
	}

	// One limit hit exhausts the whole pool, so a model-keyed entry cools every pool-mate.
	const hits = offers
		.filter((o) => o.pool === pool && (state.exhausted[o.id] ?? 0) * 1000 > state.nowMs)
		.map((o) => ({ id: o.id, untilMs: (state.exhausted[o.id] ?? 0) * 1000 }))
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

	for (const b of state.blocks) {
		if (b.untilMs > state.nowMs && (b.family === o.family || b.pool === pool.id)) {
			reasons.push(`${b.why} until ${clock(b.untilMs)}`);
		}
	}

	if (pool.explicitOnly) {
		reasons.push(`${pool.plan} plan is explicit-use only`);
	}

	const id = o.id.toLowerCase();

	if (
		state.deny.includes(o.id) ||
		state.deny.includes(o.provider) ||
		state.denyPatterns.some((p) => id.includes(p))
	) {
		reasons.push("denied in pools.json");
	}

	if (o.score <= 0) {
		reasons.push("unscored");
	}

	if (state.dataClass === "sensitive") {
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
}

export interface Pick {
	tier: string | undefined;
	ranked: Ranked[];
	excluded: { offer: Offer; reasons: string[] }[];
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

		if (j.reasons.length === 0 && inBand) {
			const headroom = j.offer.pool ? (pools.get(j.offer.pool)?.headroom ?? 100) : 0;

			ranked.push({ offer: j.offer, rank: j.offer.score + j.offer.bonus + headroom / 1000 });
		} else {
			const reasons = inBand
				? j.reasons
				: [...j.reasons, `score ${String(j.offer.score)} outside tier ${chosen ?? tier}`];

			excluded.push({ offer: j.offer, reasons });
		}
	}

	ranked.sort((a, b) => b.rank - a.rank);

	return { tier: chosen, ranked, excluded };
}
