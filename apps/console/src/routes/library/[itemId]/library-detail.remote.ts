import { publicConfig } from "$lib/config";
import {
	libraryLinks,
	libraryProvenance,
	mockLibrary,
	type LibraryItemView,
	type LibraryLinkFixture,
} from "$lib/data/library";
import {
	mockWorkSettlement,
	settledTaskLibraryItem,
	type SettlingTask,
} from "$lib/data/work-settlement";
import {
	isDashboardError,
	listLibraryItems,
	listLibraryLinks,
	readLibraryItem,
	readLibraryItemHistory,
} from "$lib/server/domain/dashboard/store";
import { currentPrincipal } from "$lib/server/domain/principal";
import { readWorkSettlement } from "$lib/server/domain/reads/work-settlement";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect, Schema } from "effect";
import { Error as HttpError, Query } from "svelte-effect-runtime";

export interface LibraryRevision {
	version: number;
	txFrom: string;
	item: LibraryItemView;
}
export interface LibraryDetail {
	item: LibraryItemView;
	links: Array<LibraryLinkFixture & { target: LibraryItemView | null }>;
	revisions: LibraryRevision[];
	responsibleHuman: string;
	txFrom: string;
	isMock: boolean;
}

const idSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:_-]{1,128}$/));
type ApiItem = {
	id: string;
	kind: LibraryItemView["kind"];
	title: string;
	project: string;
	scope: string;
	status: string;
	version: number;
	confidence: number | null;
	protection: string;
	properties: Record<string, unknown>;
	updated_at: string;
	tx_from: string;
	provenance: {
		created_by_agent: string | null;
		responsible_human: string | null;
		handed_off_to_agent: string | null;
	};
};
type ApiLink = {
	from_id: string;
	to_id: string;
	rel_type: LibraryLinkFixture["rel"];
	reason: string | null;
};
function view(item: ApiItem): LibraryItemView {
	return {
		id: item.id,
		title: item.title,
		kind: item.kind,
		project: item.project,
		scope: item.scope,
		status: item.status,
		version: item.version,
		updated: new Date(item.updated_at).toLocaleString(),
		creator: item.provenance.created_by_agent ?? "unknown",
		confidence: item.confidence ?? undefined,
		protection: item.protection,
		handedOffTo: item.provenance.handed_off_to_agent ?? undefined,
		body:
			typeof item.properties["body"] === "string"
				? item.properties["body"]
				: "Body is stored by reference in the Library.",
	};
}

function taskDetail(task: SettlingTask, isMock: boolean): LibraryDetail {
	const item = settledTaskLibraryItem(task);
	return {
		item,
		links: [],
		revisions: [{ version: item.version, txFrom: task.updated_at, item }],
		responsibleHuman: task.owner ?? "unassigned",
		txFrom: task.updated_at,
		isMock,
	};
}

export const getLibraryItemDetail = Query(idSchema, (id) =>
	Effect.gen(function* () {
		if (id.startsWith("task:")) {
			const isMock = publicConfig.dataMode === "mock";
			let settlement: ReturnType<typeof mockWorkSettlement>;
			if (isMock) settlement = mockWorkSettlement();
			else {
				const domain = yield* ConsoleDomain;
				const services = yield* domain.services;
				const principal = yield* currentPrincipal;
				if (!services.tracker)
					return yield* HttpError("ServiceUnavailable", "Work settlement is unavailable");
				settlement = (yield* readWorkSettlement(
					services.tracker,
					principal.scopes,
				)) as unknown as ReturnType<typeof mockWorkSettlement>;
			}
			const task = [...settlement.settling, ...settlement.history].find(
				(candidate) => `task:${String(candidate.id)}` === id,
			);
			if (!task) return yield* HttpError("NotFound", "Library task not found");
			return taskDetail(task, isMock);
		}
		if (publicConfig.dataMode === "mock") {
			const item = mockLibrary.items.find((candidate) => candidate.id === id);
			if (!item) return yield* HttpError("NotFound", "Library item not found");
			const txFrom = libraryProvenance[id].txFrom;
			return {
				item,
				links: (libraryLinks[id] ?? []).map((link) => ({
					...link,
					target: mockLibrary.items.find((candidate) => candidate.id === link.targetId) ?? null,
				})),
				revisions: [0, 1, 2]
					.filter((offset) => item.version - offset > 0)
					.map((offset) => ({
						version: item.version - offset,
						txFrom: new Date(Date.parse(txFrom) - offset * 86400000).toISOString(),
						item: { ...item, version: item.version - offset },
					})),
				responsibleHuman: libraryProvenance[id].responsibleHuman,
				txFrom,
				isMock: true,
			};
		}
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const [current, history, links, items] = (yield* Effect.all(
			[
				readLibraryItem(services.db.app, principal.scopes, id),
				readLibraryItemHistory(services.db.app, principal.scopes, id),
				listLibraryLinks(services.db.app, principal.scopes, services.cursorSecret, id, {
					limit: 100,
				}),
				listLibraryItems(services.db.app, principal.scopes, services.cursorSecret, {
					limit: 1_000,
				}),
			],
			{ concurrency: "unbounded" },
		).pipe(
			Effect.catch((cause) =>
				isDashboardError(cause) ? HttpError("BadRequest", cause.message) : Effect.die(cause),
			),
		)) as [
			{ item: ApiItem } | null,
			{ items: Array<{ version: number; tx_from: string; item: ApiItem }> },
			{ items: ApiLink[] },
			{ items: ApiItem[] },
		];
		if (!current) return yield* HttpError("NotFound", "Library item not found");
		const targets = new Map(items.items.map((candidate) => [candidate.id, view(candidate)]));
		return {
			item: view(current.item),
			links: links.items.map((link) => {
				const outgoing = link.from_id === id;
				const targetId = outgoing ? link.to_id : link.from_id;
				const target = targets.get(targetId);
				return {
					direction: outgoing ? "out" : "in",
					rel: link.rel_type,
					targetId,
					...(link.reason ? { reason: link.reason } : {}),
					target: target?.status === "invalidated" ? null : (target ?? null),
				};
			}),
			revisions: history.items.map((revision) => ({
				version: revision.version,
				txFrom: revision.tx_from,
				item: view(revision.item),
			})),
			responsibleHuman: current.item.provenance.responsible_human ?? "unassigned",
			txFrom: current.item.tx_from,
			isMock: false,
		};
	}),
);
