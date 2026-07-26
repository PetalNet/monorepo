import type { ExecutorItem, ReadEnvelope } from "$lib/api/types";
import { publicConfig } from "$lib/config";
import {
	mockLibrary,
	assembleLiveLibrary,
	type LibraryItemView,
	type LibraryKind,
} from "$lib/data/library";
import { settledTaskLibraryItem } from "$lib/data/work-settlement";
import { executeNamedOp, readPlaneRemote, sendAssistantRemote } from "$lib/operations.remote";
import {
	isDashboardError,
	listLibraryCapabilities,
	listLibraryCuration,
	listLibraryHolds,
	listLibraryItems,
	listLibraryLinks,
} from "$lib/server/domain/dashboard/store";
import { currentPrincipal } from "$lib/server/domain/principal";
import { readWorkSettlement } from "$lib/server/domain/reads/work-settlement";
import { acquireCapability } from "$lib/server/domain/registry/acquisition";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { ConsoleDomain } from "$lib/server/domain/service";
import { Effect, Exit, Schema } from "effect";
import { Command, Error as HttpError, Query } from "svelte-effect-runtime";

import { formatUnknown } from "#format";

const viewSchema = Schema.Literals(["desk", "graph", "kanban", "table"]);
const messageSchema = Schema.Struct({
	message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
	view: viewSchema,
	query: Schema.String.check(Schema.isMaxLength(500)),
	selected_item_id: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
}).annotate(rejectUnknownKeys);
const searchSchema = Schema.Struct({
	query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
}).annotate(rejectUnknownKeys);
const acquisitionSchema = Schema.Struct({
	capability: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
}).annotate(rejectUnknownKeys);
const acquisitionResultSchema = Schema.Struct({
	capability: Schema.String,
	kind: Schema.Literals(["skill", "tool"]),
	version: Schema.String,
	provider: Schema.String,
	scope: Schema.String,
	integrity: Schema.Struct({
		algorithm: Schema.Literal("sha256"),
		digest: Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64)),
	}),
	artifact: Schema.Struct({
		bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	}),
	provenance: Schema.Struct({ library_item_id: Schema.String }),
});
export type LibraryAcquisitionReceipt = typeof acquisitionResultSchema.Type;
const statusSchema = Schema.Struct({
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	status: Schema.Literals([
		"todo",
		"doing",
		"review",
		"done",
		"draft",
		"verified-shared",
		"superseded",
		"invalidated",
	]),
	expected_version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
}).annotate(rejectUnknownKeys);
const statusResultSchema = Schema.Struct({
	id: Schema.String,
	status: Schema.String,
	version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	conflict: Schema.optional(
		// Conflict payloads tolerate extra keys (zod `.loose()` parity).
		Schema.StructWithRest(
			Schema.Struct({ values: Schema.Array(Schema.String).check(Schema.isMinLength(2)) }),
			[Schema.Record(Schema.String, Schema.Unknown)],
		),
	),
});
const reviewSchema = Schema.Struct({
	proposal_id: Schema.String.check(Schema.isMinLength(1)),
	decision: Schema.Literals(["under-review", "promoted", "rejected"]),
	reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
}).annotate(rejectUnknownKeys);
const reviewResultSchema = Schema.Struct({
	proposal_id: Schema.String,
	capability: Schema.String,
	version: Schema.String,
	state: Schema.String,
	reviewed_by: Schema.String,
});

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
	return publicConfig.dataMode === "mock";
}

const settle = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<PromiseSettledResult<A>> =>
	effect.pipe(
		Effect.map((value) => ({ status: "fulfilled" as const, value })),
		Effect.catch((reason) => Effect.succeed({ status: "rejected" as const, reason })),
	);

/**
 * The complete Library lens crosses one SvelteKit RPC boundary; the browser never reads the API
 * directly.
 */
export const getLibrarySurface = Query(
	Effect.gen(function* () {
		if (isMock()) return mockLibrary;
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const [items, links, holds, curation, capabilities, executorsResult] = yield* Effect.all(
			[
				settle(
					listLibraryItems(services.db.app, principal.scopes, services.cursorSecret, {
						limit: 1_000,
					}),
				),
				settle(
					listLibraryLinks(services.db.app, principal.scopes, services.cursorSecret, undefined, {
						limit: 1_000,
					}),
				),
				settle(
					listLibraryHolds(services.db.app, principal.scopes, principal.id, services.cursorSecret, {
						limit: 1_000,
					}),
				),
				settle(
					listLibraryCuration(services.db.app, principal.scopes, services.cursorSecret, {
						limit: 1_000,
					}),
				),
				settle(
					listLibraryCapabilities(services.db.app, principal.scopes, services.cursorSecret, {
						limit: 1_000,
					}),
				),
				settle(readPlaneRemote("executors")),
			],
			{ concurrency: "unbounded" },
		);
		const library = assembleLiveLibrary([items, links, holds, curation, capabilities] as never);
		const executors =
			executorsResult.status === "fulfilled"
				? (executorsResult.value as ReadEnvelope<ExecutorItem>)
				: null;
		return {
			...library,
			libraryExecutorLive:
				executors?.items.some(
					(executor) => executor.kind === "library" && executor.liveness === "alive",
				) ?? false,
		};
	}),
);

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
			intent: record["intent"],
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
export const searchLibrary = Query(searchSchema, ({ query: searchQuery }) =>
	Effect.gen(function* () {
		if (isMock()) return [];
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const [result, settlement] = yield* Effect.all(
			[
				listLibraryItems(services.db.app, principal.scopes, services.cursorSecret, {
					query: searchQuery,
					limit: 100,
				}).pipe(
					Effect.catch((cause) =>
						isDashboardError(cause) ? HttpError("BadRequest", cause.message) : Effect.die(cause),
					),
				),
				services.tracker
					? readWorkSettlement(services.tracker, principal.scopes)
					: Effect.succeed(null),
			],
			{ concurrency: "unbounded" },
		);
		const needle = searchQuery.toLocaleLowerCase();
		const taskMatches = (settlement?.history ?? [])
			.filter((task) =>
				[task.title, task.body, task.result_summary, task.close_reason, task.project_title]
					.map((value) => formatUnknown(value ?? ""))
					.join(" ")
					.toLocaleLowerCase()
					.includes(needle),
			)
			.map((task) => settledTaskLibraryItem(task as never));
		const taskIds = new Set(taskMatches.map((item) => item.id));
		const items = (result["items"] as ApiLibraryItem[]).map(itemView);
		return [...taskMatches, ...items.filter((item) => !taskIds.has(item.id))];
	}),
);

/** Prove the artifact is runnable through the caller-scoped acquisition endpoint. */
export const verifyLibraryCapability = Command(acquisitionSchema, (input) =>
	Effect.gen(function* () {
		if (isMock()) {
			const receipt: LibraryAcquisitionReceipt = {
				capability: input.capability,
				kind: input.capability.startsWith("skill.") ? "skill" : "tool",
				version: "fixture",
				provider: input.provider,
				scope: "fleet-public",
				integrity: { algorithm: "sha256", digest: "0".repeat(64) },
				artifact: { bytes: 512 },
				provenance: { library_item_id: "fixture-capability" },
			};
			return receipt;
		}
		const domain = yield* ConsoleDomain;
		const services = yield* domain.services;
		const principal = yield* currentPrincipal;
		const result = yield* acquireCapability(
			services.db.app,
			principal.scopes,
			input.capability,
			input.provider,
		).pipe(Effect.catch((cause) => HttpError("BadRequest", cause.message)));
		const parsed = Schema.decodeUnknownExit(acquisitionResultSchema)(result);
		if (Exit.isFailure(parsed))
			return yield* HttpError("BadGateway", "Registry returned an invalid acquisition receipt");
		return parsed.value;
	}),
);

/** Status movement uses the same named operation and audit line available to agents. */
export const updateLibraryStatus = Command(statusSchema, (input) =>
	Effect.gen(function* () {
		if (isMock())
			return { id: input.id, status: input.status, version: input.expected_version + 1 };
		const result = yield* executeNamedOp({
			id: crypto.randomUUID(),
			op: "library.item.update",
			args: {
				id: input.id,
				patch: { status: input.status, expected_version: input.expected_version },
			},
			dry_run: false,
		});
		if (!result.ok) return yield* HttpError("BadRequest", result.error.message);
		yield* getLibrarySurface().refresh();
		const parsed = Schema.decodeUnknownExit(statusResultSchema)(result.result);
		if (Exit.isFailure(parsed))
			return yield* HttpError("BadGateway", "Library returned an invalid status receipt");
		return parsed.value;
	}),
);

/** Privileged curation stays on the audited op plane; the UI cannot promote directly. */
export const reviewLibraryCapability = Command(reviewSchema, (input) =>
	Effect.gen(function* () {
		const result = yield* executeNamedOp({
			id: crypto.randomUUID(),
			op: "library.capability.review",
			args: { proposal_id: input.proposal_id, decision: input.decision },
			reason: input.reason,
			dry_run: false,
		});
		if (!result.ok) return yield* HttpError("BadRequest", result.error.message);
		const parsed = Schema.decodeUnknownExit(reviewResultSchema)(result.result);
		if (Exit.isFailure(parsed))
			return yield* HttpError("BadGateway", "Library returned an invalid review receipt");
		yield* getLibrarySurface().refresh();
		return parsed.value;
	}),
);

/** Continue the real caller-scoped Claude Code manager session through a server-only RPC. */
export const sendLibraryManagerMessage = Command(messageSchema, (input) =>
	Effect.gen(function* () {
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
		const response = (yield* sendAssistantRemote({
			kind: "user",
			content,
		})) as Omit<LibraryManagerResult, "library_action">;
		return { ...response, library_action: libraryManagerAction(response.tool_results) };
	}),
);
