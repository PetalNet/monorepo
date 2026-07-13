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
	body: string;
}
export interface LibraryData {
	items: LibraryItemView[];
	isMock: boolean;
	connected: boolean;
}

export const mockLibrary: LibraryData = {
	isMock: true,
	connected: true,
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
	],
};

export const liveEmptyLibrary: LibraryData = { items: [], isMock: false, connected: false };

export interface LibraryLinkFixture {
	direction: "in" | "out";
	rel: "belongs-to" | "references" | "derived-from";
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
};
