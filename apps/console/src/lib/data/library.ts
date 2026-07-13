import { env } from "$env/dynamic/public";

export type LibraryKind =
	| "task"
	| "project"
	| "doc"
	| "artifact"
	| "research"
	| "fact"
	| "decision"
	| "how-to";
export interface LibraryItemView {
	id: string;
	title: string;
	kind: LibraryKind;
	project: string;
	scope: string;
	status: string;
	version: number;
	updated: string;
	creator: string;
	confidence?: number;
	hold?: string;
	protection?: string;
	handedOffTo?: string;
	body: string;
}
export interface LibraryData {
	items: LibraryItemView[];
	isMock: boolean;
	connected: boolean;
	links?: Record<string, LibraryLinkFixture[]>;
	provenance?: Record<string, { responsibleHuman: string; txFrom: string }>;
	capabilities?: LibraryCapabilityView[];
	curation?: LibraryCurationView[];
	sources?: Record<string, "live" | "unavailable">;
	libraryExecutorLive?: boolean;
}

export const mockLibrary: LibraryData = {
	isMock: true,
	connected: true,
	libraryExecutorLive: true,
	items: [
		{
			id: "kb-1",
			title: "Backoff and retry discipline for fleet writers",
			kind: "how-to",
			project: "fleet",
			scope: "fleet-public",
			status: "verified-shared",
			version: 3,
			updated: "2d",
			creator: "carson-2",
			confidence: 0.94,
			hold: "Held: relates to /task/712",
			body: "Use bounded exponential backoff with jitter. Writers must preserve the lease fence and stop after the retry budget is exhausted.",
		},
		{
			id: "kb-2",
			title: "Doorman is the sole egress for research",
			kind: "decision",
			project: "library",
			scope: "fleet-public",
			status: "verified-shared",
			version: 1,
			updated: "5d",
			creator: "janet",
			confidence: 0.97,
			hold: "Held: you asked about egress Tuesday",
			body: "All external research routes through the doorman proxy. Findings return through the consolidation gate.",
		},
		{
			id: "kb-3",
			title: "Consolidation gate: what gets written back",
			kind: "doc",
			project: "library",
			scope: "project:library",
			status: "verified-shared",
			version: 4,
			updated: "8d",
			creator: "janet",
			hold: "Recommended: follows the retry postmortem you read",
			body: "The gate checks provenance, novelty, scope, and duplication before durable write-back.",
		},
		{
			id: "kb-4",
			title: "Lease fencing checklist for writers",
			kind: "task",
			project: "fleet",
			scope: "fleet-public",
			status: "review",
			version: 2,
			updated: "4d",
			creator: "carson-2",
			hold: "Recommended: pairs with /task/712",
			body: "Confirm the current fence immediately before every externally visible write.",
		},
		{
			id: "kb-5",
			title: "Loro merges prose, MV-Register owns status",
			kind: "fact",
			project: "library",
			scope: "fleet-public",
			status: "verified-shared",
			version: 2,
			updated: "6d",
			creator: "point-fable",
			confidence: 0.96,
			body: "Concurrent prose merges through Loro. Workflow status remains an MV-Register so disagreement becomes visible.",
		},
		{
			id: "kb-6",
			title: "Rev3 item and link model",
			kind: "doc",
			project: "library",
			scope: "project:library",
			status: "draft",
			version: 7,
			updated: "1d",
			creator: "janet",
			body: "One polymorphic item substrate with governed typed links and bitemporal revisions.",
		},
		{
			id: "kb-7",
			title: "pgvector and BM25 recall notes",
			kind: "research",
			project: "fleet",
			scope: "fleet-public",
			status: "draft",
			version: 1,
			updated: "3d",
			creator: "carson-2",
			confidence: 0.91,
			body: "Hybrid retrieval joins lexical and dense ranks with reciprocal-rank fusion.",
		},
		{
			id: "kb-8",
			title: "Weekly cost digest, rendered",
			kind: "artifact",
			project: "cost",
			scope: "fleet-public",
			status: "verified-shared",
			version: 1,
			updated: "4m",
			creator: "janet",
			body: "Rendered accounting artifact.",
		},
		{
			id: "kb-9",
			title: "Verify Library view keyboard paths",
			kind: "task",
			project: "library",
			scope: "project:library",
			status: "todo",
			version: 1,
			updated: "12m",
			creator: "janet",
			body: "Walk each graph edge and each status lane without a pointer.",
		},
		{
			id: "kb-10",
			title: "Backfill typed relationships",
			kind: "task",
			project: "library",
			scope: "project:library",
			status: "doing",
			version: 2,
			updated: "7m",
			creator: "carson-2",
			body: "Attach governed relationship types to the imported Library corpus.",
		},
		{
			id: "kb-11",
			title: "Promotion status disagreement",
			kind: "doc",
			project: "library",
			scope: "project:library",
			status: "CONFLICT",
			version: 5,
			updated: "3m",
			creator: "point-fable",
			body: "Two writers proposed different promotion states. Human adjudication is required.",
		},
	],
};

const liveEmptyLibrary: LibraryData = { items: [], isMock: false, connected: false };

export interface LibraryLinkFixture {
	direction: "in" | "out";
	rel: "belongs-to" | "references" | "derived-from" | "supersedes" | "duplicate-of";
	targetId: string;
	reason?: string;
}
export const libraryLinks: Record<string, LibraryLinkFixture[]> = {
	"kb-1": [
		{
			direction: "out",
			rel: "references",
			targetId: "kb-6",
			reason: "Uses the Rev3 provenance model",
		},
		{ direction: "out", rel: "derived-from", targetId: "kb-7" },
	],
	"kb-2": [{ direction: "out", rel: "references", targetId: "kb-3" }],
	"kb-3": [
		{ direction: "in", rel: "references", targetId: "kb-2" },
		{ direction: "out", rel: "belongs-to", targetId: "kb-6" },
	],
	"kb-4": [{ direction: "out", rel: "references", targetId: "kb-1" }],
	"kb-5": [{ direction: "out", rel: "derived-from", targetId: "kb-6" }],
	"kb-6": [{ direction: "in", rel: "references", targetId: "kb-1" }],
	"kb-7": [{ direction: "in", rel: "derived-from", targetId: "kb-1" }],
	"kb-8": [],
	"kb-9": [{ direction: "out", rel: "references", targetId: "kb-6" }],
	"kb-10": [{ direction: "out", rel: "belongs-to", targetId: "kb-6" }],
	"kb-11": [{ direction: "out", rel: "references", targetId: "kb-5" }],
};
export const libraryProvenance: Record<string, { responsibleHuman: string; txFrom: string }> = {
	"kb-1": { responsibleHuman: "parker", txFrom: "2026-07-11T04:12:00Z" },
	"kb-2": { responsibleHuman: "eli", txFrom: "2026-07-08T09:00:00Z" },
	"kb-3": { responsibleHuman: "eli", txFrom: "2026-07-05T16:20:00Z" },
	"kb-4": { responsibleHuman: "parker", txFrom: "2026-07-09T11:00:00Z" },
	"kb-5": { responsibleHuman: "eli", txFrom: "2026-07-07T12:00:00Z" },
	"kb-6": { responsibleHuman: "eli", txFrom: "2026-07-12T18:05:00Z" },
	"kb-7": { responsibleHuman: "parker", txFrom: "2026-07-10T08:14:00Z" },
	"kb-8": { responsibleHuman: "parker", txFrom: "2026-07-13T05:55:00Z" },
	"kb-9": { responsibleHuman: "eli", txFrom: "2026-07-13T19:48:00Z" },
	"kb-10": { responsibleHuman: "parker", txFrom: "2026-07-13T19:53:00Z" },
	"kb-11": { responsibleHuman: "eli", txFrom: "2026-07-13T19:57:00Z" },
};

export interface LibraryCapabilityView {
	capability: string;
	provider: string;
	host: string | null;
	transport: string | null;
	observedAt: string;
	fresh: boolean;
}

export interface LibraryCurationView {
	id: string;
	itemId: string;
	type: string;
	reason: string;
	linksIn: number;
	activeTaskLinks: number;
	proposedAt: string;
}

interface ApiEnvelope<T> {
	items: T[];
	next_cursor?: string | null;
}

interface ApiLibraryItem {
	id: string;
	kind: LibraryKind;
	title: string;
	scope: string;
	project: string;
	status: string;
	protection: string;
	confidence: number | null;
	properties: Record<string, unknown>;
	version: number;
	tx_from: string;
	updated_at: string;
	provenance: {
		created_by_agent: string | null;
		responsible_human: string | null;
		handed_off_to_agent: string | null;
	};
}

interface ApiLibraryLink {
	from_id: string;
	to_id: string;
	rel_type: LibraryLinkFixture["rel"];
	reason: string | null;
}

interface ApiLibraryHold {
	item_id: string;
	reason: string;
}

interface ApiLibraryCapability {
	capability: string;
	provider: string;
	host: string | null;
	transport: string | null;
	observed_at: string;
	fresh: boolean;
}

interface ApiLibraryCuration {
	id: string;
	item_id: string;
	proposal_type: string;
	reason: string;
	links_in: number;
	active_task_links: number;
	proposed_at: string;
}

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}

async function readEnvelope<T>(path: string, fetchFn: typeof fetch): Promise<ApiEnvelope<T>> {
	const response = await fetchFn(`${apiBase()}${path}`, {
		headers: { accept: "application/json" },
		credentials: "include",
	});
	if (!response.ok) throw new Error(`Library source ${path} returned ${String(response.status)}`);
	return (await response.json()) as ApiEnvelope<T>;
}

async function readAllPages<T>(path: string, fetchFn: typeof fetch): Promise<ApiEnvelope<T>> {
	const items: T[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		const separator = path.includes("?") ? "&" : "?";
		// Cursor pages are ordered and each request depends on the previous response.
		// oxlint-disable-next-line no-await-in-loop
		const page: ApiEnvelope<T> = await readEnvelope<T>(
			cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path,
			fetchFn,
		);
		items.push(...page.items);
		cursor = page.next_cursor ?? null;
		if (cursor && seen.has(cursor)) throw new Error("Library pagination repeated a cursor");
		if (cursor) seen.add(cursor);
	} while (cursor);
	return { items, next_cursor: null };
}

function relativeTime(value: string): string {
	const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 60) return `${String(minutes)}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${String(hours)}h`;
	return `${String(Math.floor(hours / 24))}d`;
}

function mapLibraryItem(item: ApiLibraryItem, hold?: string): LibraryItemView {
	return {
		id: item.id,
		title: item.title,
		kind: item.kind,
		project: item.project,
		scope: item.scope,
		status: item.status,
		version: item.version,
		updated: relativeTime(item.updated_at),
		creator: item.provenance.created_by_agent ?? "unknown",
		protection: item.protection,
		...(item.provenance.handed_off_to_agent
			? { handedOffTo: item.provenance.handed_off_to_agent }
			: {}),
		...(item.confidence === null ? {} : { confidence: item.confidence }),
		...(hold ? { hold } : {}),
		body:
			typeof item.properties["body"] === "string"
				? item.properties["body"]
				: item.kind === "artifact"
					? "Rendered Library artifact."
					: "Body is stored by reference in the Library.",
	};
}

/** Map the scope-filtered Rev3 read surface; optional sources fail independently and honestly. */
export async function readLiveLibrary(fetchFn: typeof fetch = fetch): Promise<LibraryData> {
	const [itemsResult, linksResult, holdsResult, curationResult, capabilitiesResult] =
		await Promise.allSettled([
			readAllPages<ApiLibraryItem>("/library/items?limit=1000", fetchFn),
			readAllPages<ApiLibraryLink>("/library/links?limit=1000", fetchFn),
			readAllPages<ApiLibraryHold>("/library/holds?limit=1000", fetchFn),
			readAllPages<ApiLibraryCuration>("/library/curation?limit=1000", fetchFn),
			readAllPages<ApiLibraryCapability>("/library/capabilities?limit=1000", fetchFn),
		]);
	if (itemsResult.status === "rejected") return liveEmptyLibrary;
	const holds = holdsResult.status === "fulfilled" ? holdsResult.value.items : [];
	const holdByItem = new Map(
		holds.map((hold) => [
			hold.item_id,
			hold.reason === "recommended" ? "Recommended: librarian pick" : `Held: ${hold.reason}`,
		]),
	);
	const items = itemsResult.value.items.map((item) =>
		mapLibraryItem(item, holdByItem.get(item.id)),
	);
	const links: Record<string, LibraryLinkFixture[]> = {};
	if (linksResult.status === "fulfilled") {
		for (const link of linksResult.value.items) {
			(links[link.from_id] ??= []).push({
				direction: "out",
				rel: link.rel_type,
				targetId: link.to_id,
				...(link.reason ? { reason: link.reason } : {}),
			});
			(links[link.to_id] ??= []).push({
				direction: "in",
				rel: link.rel_type,
				targetId: link.from_id,
				...(link.reason ? { reason: link.reason } : {}),
			});
		}
	}
	return {
		items,
		isMock: false,
		connected: true,
		links,
		provenance: Object.fromEntries(
			itemsResult.value.items.map((item) => [
				item.id,
				{
					responsibleHuman: item.provenance.responsible_human ?? "unassigned",
					txFrom: item.tx_from,
				},
			]),
		),
		capabilities:
			capabilitiesResult.status === "fulfilled"
				? capabilitiesResult.value.items.map((item) => ({
						capability: item.capability,
						provider: item.provider,
						host: item.host,
						transport: item.transport,
						observedAt: item.observed_at,
						fresh: item.fresh,
					}))
				: [],
		curation:
			curationResult.status === "fulfilled"
				? curationResult.value.items.map((item) => ({
						id: item.id,
						itemId: item.item_id,
						type: item.proposal_type,
						reason: item.reason,
						linksIn: item.links_in,
						activeTaskLinks: item.active_task_links,
						proposedAt: item.proposed_at,
					}))
				: [],
		sources: {
			items: "live",
			links: linksResult.status === "fulfilled" ? "live" : "unavailable",
			holds: holdsResult.status === "fulfilled" ? "live" : "unavailable",
			curation: curationResult.status === "fulfilled" ? "live" : "unavailable",
			capabilities: capabilitiesResult.status === "fulfilled" ? "live" : "unavailable",
		},
	};
}
