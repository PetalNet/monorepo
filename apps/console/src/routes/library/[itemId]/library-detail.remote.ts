import { getRequestEvent, query } from "$app/server";
const env = import.meta.env;
import type { WorkSettlementSnapshot } from "$lib/api/types";
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
import { error } from "@sveltejs/kit";
import { Schema } from "effect";

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
function base() {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}
function headers() {
	const incoming = getRequestEvent().request.headers;
	const out = new Headers({ accept: "application/json" });
	for (const key of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(key);
		if (value) out.set(key, value);
	}
	return out;
}
async function api<T>(path: string): Promise<T> {
	const response = await getRequestEvent().fetch(`${base()}${path}`, { headers: headers() });
	if (!response.ok)
		error(
			response.status,
			response.status === 404 ? "Library item not found" : "Library detail is unavailable",
		);
	return response.json() as Promise<T>;
}
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

export const getLibraryItemDetail = query(
	Schema.toStandardSchemaV1(idSchema),
	async (id): Promise<LibraryDetail> => {
		if (id.startsWith("task:")) {
			const isMock = env.PUBLIC_CONSOLE_DATA_MODE !== "live";
			const settlement = isMock
				? mockWorkSettlement()
				: await api<WorkSettlementSnapshot>("/work/settlement");
			const task = [...settlement.settling, ...settlement.history].find(
				(candidate) => `task:${String(candidate.id)}` === id,
			);
			if (!task) error(404, "Library task not found");
			return taskDetail(task, isMock);
		}
		if (env.PUBLIC_CONSOLE_DATA_MODE !== "live") {
			const item = mockLibrary.items.find((candidate) => candidate.id === id);
			if (!item) error(404, "Library item not found");
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
		const encoded = encodeURIComponent(id);
		const [current, history, links, items] = await Promise.all([
			api<{ item: ApiItem }>(`/library/items/${encoded}`),
			api<{ items: Array<{ version: number; tx_from: string; item: ApiItem }> }>(
				`/library/items/${encoded}/history`,
			),
			api<{ items: ApiLink[] }>(`/library/links?item_id=${encoded}&limit=100`),
			api<{ items: ApiItem[] }>("/library/items?limit=1000"),
		]);
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
	},
);
