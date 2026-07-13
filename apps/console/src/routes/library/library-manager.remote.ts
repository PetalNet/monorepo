import { getRequestEvent, command, query } from "$app/server";
import { env } from "$env/dynamic/public";
import type { ExecutorItem, OpResult, ReadEnvelope } from "$lib/api/types";
import {
	mockLibrary,
	readLiveLibrary,
	type LibraryData,
	type LibraryItemView,
	type LibraryKind,
} from "$lib/data/library";
import { error } from "@sveltejs/kit";
import { z } from "zod";

const viewSchema = z.enum(["desk", "graph", "kanban", "table"]);
const messageSchema = z
	.object({
		message: z.string().trim().min(1).max(4_000),
		view: viewSchema,
		query: z.string().max(500),
		selected_item_id: z.string().max(256).nullable(),
	})
	.strict();
const searchSchema = z.object({ query: z.string().trim().min(1).max(500) }).strict();
const acquisitionSchema = z
	.object({
		capability: z.string().min(1).max(128),
		provider: z.string().min(1).max(128),
	})
	.strict();
const acquisitionResultSchema = z.object({
	capability: z.string(),
	kind: z.enum(["skill", "tool"]),
	version: z.string(),
	provider: z.string(),
	scope: z.string(),
	integrity: z.object({ algorithm: z.literal("sha256"), digest: z.string().length(64) }),
	artifact: z.object({ bytes: z.number().int().positive() }),
	provenance: z.object({ library_item_id: z.string() }),
});
export type LibraryAcquisitionReceipt = z.infer<typeof acquisitionResultSchema>;
const statusSchema = z
	.object({
		id: z.string().min(1).max(128),
		status: z.enum([
			"todo",
			"doing",
			"review",
			"done",
			"draft",
			"verified-shared",
			"superseded",
			"invalidated",
		]),
		expected_version: z.number().int().positive(),
	})
	.strict();
const statusResultSchema = z.object({
	id: z.string(),
	status: z.string(),
	version: z.number().int().positive(),
	conflict: z
		.object({ values: z.array(z.string()).min(2) })
		.passthrough()
		.optional(),
});
export type LibraryStatusResult = z.infer<typeof statusResultSchema>;

export interface LibraryManagerResult {
	schema_version: 1;
	session_id: string;
	message_id: string;
	content: string;
	tool_results: unknown[];
	library_action: LibraryManagerAction | null;
}

export interface LibraryManagerIntent {
	view?: "desk" | "graph" | "kanban" | "table";
	query?: string;
	item_id?: string;
	focus?: string;
}

export interface LibraryManagerAction {
	intent: LibraryManagerIntent;
	items: LibraryItemView[];
	item: LibraryItemView | null;
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
	updated_at: string;
	provenance: {
		created_by_agent: string | null;
		handed_off_to_agent: string | null;
	};
}

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE !== "live";
}

function apiBase(): string {
	return env.PUBLIC_CONSOLE_API_BASE ?? "https://console-api.petalcat.dev/api/v1";
}

function forwardedHeaders(contentType = false): Headers {
	const incoming = getRequestEvent().request.headers;
	const headers = new Headers({ accept: "application/json" });
	for (const name of ["authorization", "cookie", "x-dev-principal"]) {
		const value = incoming.get(name);
		if (value) headers.set(name, value);
	}
	if (contentType) headers.set("content-type", "application/json");
	return headers;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await getRequestEvent().fetch(`${apiBase()}${path}`, {
		...init,
		headers: init?.headers ?? forwardedHeaders(init?.body !== undefined),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		error(
			response.status,
			body?.error?.message ?? `Console API returned ${String(response.status)}`,
		);
	}
	return (await response.json()) as T;
}

/**
 * The complete Library lens crosses one SvelteKit RPC boundary; the browser never reads the API
 * directly.
 */
export const getLibrarySurface = query(async (): Promise<LibraryData> => {
	if (isMock()) return mockLibrary;
	const serverFetch: typeof fetch = (input, init) => {
		const supplied = new Headers(init?.headers);
		for (const [name, value] of forwardedHeaders())
			if (!supplied.has(name)) supplied.set(name, value);
		return getRequestEvent().fetch(input, { ...init, headers: supplied });
	};
	const [library, executors] = await Promise.all([
		readLiveLibrary(serverFetch),
		apiJson<ReadEnvelope<ExecutorItem>>("/executors").catch(() => null),
	]);
	return {
		...library,
		libraryExecutorLive:
			executors?.items.some(
				(executor) => executor.kind === "library" && executor.liveness === "alive",
			) ?? false,
	};
});

function relativeTime(value: string): string {
	const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
	if (minutes < 60) return `${String(minutes)}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
}

function itemView(item: ApiLibraryItem): LibraryItemView {
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
		body:
			typeof item.properties["body"] === "string"
				? item.properties["body"]
				: "Body is stored by reference in the Library.",
	};
}

function isApiLibraryItem(value: unknown): value is ApiLibraryItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<ApiLibraryItem>;
	return (
		typeof item.id === "string" &&
		typeof item.title === "string" &&
		typeof item.kind === "string" &&
		typeof item.updated_at === "string" &&
		!!item.provenance &&
		typeof item.provenance === "object"
	);
}

function libraryManagerAction(value: unknown, depth = 0): LibraryManagerAction | null {
	if (depth > 6 || !value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record["surface"] === "library" && record["intent"] && typeof record["intent"] === "object") {
		const data =
			record["data"] && typeof record["data"] === "object"
				? (record["data"] as Record<string, unknown>)
				: null;
		const rawItems = Array.isArray(data?.["items"]) ? data["items"] : [];
		const rawItem = data?.["item"];
		return {
			intent: record["intent"] as LibraryManagerIntent,
			items: rawItems.filter(isApiLibraryItem).map(itemView),
			item: isApiLibraryItem(rawItem) ? itemView(rawItem) : null,
		};
	}
	for (const child of Array.isArray(value) ? value : Object.values(record)) {
		const action = libraryManagerAction(child, depth + 1);
		if (action) return action;
	}
	return null;
}

/** Literal stacks search stays deterministic while crossing the required SvelteKit RPC boundary. */
export const searchLibrary = query(
	searchSchema,
	async ({ query: searchQuery }): Promise<LibraryItemView[]> => {
		if (isMock()) return [];
		const result = await apiJson<{ items: ApiLibraryItem[] }>(
			`/library/search?limit=100&q=${encodeURIComponent(searchQuery)}`,
		);
		return result.items.map(itemView);
	},
);

/** Prove the artifact is runnable through the caller-scoped acquisition endpoint. */
export const verifyLibraryCapability = command(
	acquisitionSchema,
	async (input): Promise<LibraryAcquisitionReceipt> => {
		if (isMock())
			return {
				capability: input.capability,
				kind: input.capability.startsWith("skill.") ? "skill" : "tool",
				version: "fixture",
				provider: input.provider,
				scope: "fleet-public",
				integrity: { algorithm: "sha256", digest: "0".repeat(64) },
				artifact: { bytes: 512 },
				provenance: { library_item_id: "fixture-capability" },
			};
		const result = await apiJson<unknown>(
			`/library/capabilities/${encodeURIComponent(input.capability)}/acquire`,
			{
				method: "POST",
				headers: forwardedHeaders(true),
				body: JSON.stringify({ provider: input.provider }),
			},
		);
		const parsed = acquisitionResultSchema.safeParse(result);
		if (!parsed.success) error(502, "Registry returned an invalid acquisition receipt");
		return parsed.data;
	},
);

/** Status movement uses the same named operation and audit line available to agents. */
export const updateLibraryStatus = command(
	statusSchema,
	async (input): Promise<LibraryStatusResult> => {
		if (isMock())
			return { id: input.id, status: input.status, version: input.expected_version + 1 };
		const result = await apiJson<OpResult>("/op", {
			method: "POST",
			headers: forwardedHeaders(true),
			body: JSON.stringify({
				schema_version: 1,
				id: crypto.randomUUID(),
				op: "library.item.update",
				args: {
					id: input.id,
					patch: { status: input.status, expected_version: input.expected_version },
				},
				dry_run: false,
			}),
		});
		void getLibrarySurface().refresh();
		const parsed = statusResultSchema.safeParse(result.result);
		if (!parsed.success) error(502, "Library returned an invalid status receipt");
		return parsed.data;
	},
);

/** Continue the real caller-scoped Claude Code manager session through a server-only RPC. */
export const sendLibraryManagerMessage = command(
	messageSchema,
	async (input): Promise<LibraryManagerResult> => {
		if (isMock()) {
			const normalized = input.message.toLowerCase();
			const requestedView = (["graph", "kanban", "table", "desk"] as const).find((candidate) =>
				normalized.includes(candidate),
			);
			const intent: LibraryManagerIntent | null = normalized.includes("curation")
				? { view: "desk", focus: "curation" }
				: requestedView
					? { view: requestedView }
					: normalized.includes("retry") || normalized.includes("search")
						? { view: "table", query: normalized.includes("retry") ? "retry" : input.message }
						: null;
			return {
				schema_version: 1,
				session_id: "mock-library-manager",
				message_id: crypto.randomUUID(),
				content: intent
					? "I moved the reading room to the relevant Library view. The result remains a fixture in mock mode."
					: "I’m the Library manager fixture here. In live mode this continues your per-user Claude Code session and can work through the readable stacks.",
				tool_results: intent ? [{ schema_version: 1, surface: "library", intent }] : [],
				library_action: intent ? { intent, items: [], item: null } : null,
			};
		}
		const content = [
			"Library front-desk turn. You are continuing the caller's durable Claude Code manager session.",
			"Use library.surface when the request should change the Library view, run a stacks search, open an item, or show curation. Never claim a UI action unless that tool succeeds.",
			`Current UI: view=${input.view}; query=${JSON.stringify(input.query)}; selected_item_id=${input.selected_item_id ?? "none"}.`,
			`User request: ${input.message}`,
		].join("\n");
		const response = await apiJson<Omit<LibraryManagerResult, "library_action">>(
			"/assistant/messages",
			{
				method: "POST",
				headers: forwardedHeaders(true),
				body: JSON.stringify({ id: crypto.randomUUID(), message: content }),
			},
		);
		return { ...response, library_action: libraryManagerAction(response.tool_results) };
	},
);
