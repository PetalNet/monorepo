import { getRequestEvent, command, query } from "$app/server";
const env = import.meta.env;
import type { CardItem, ExecutorItem, OpResult, ReadEnvelope } from "$lib/api/types";
import { mockWanted } from "$lib/data/work";
import { rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { error } from "@sveltejs/kit";
import { Schema } from "effect";

const claimArgs = Schema.Struct({
	card_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	task_id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	capability: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
	updated_at_ms: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).annotate(rejectUnknownKeys);

function isMock(): boolean {
	return env.PUBLIC_CONSOLE_DATA_MODE === "mock";
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

async function apiResponse(path: string, init?: RequestInit): Promise<Response> {
	return getRequestEvent().fetch(`${apiBase()}${path}`, {
		...init,
		headers: init?.headers ?? forwardedHeaders(init?.body !== undefined),
	});
}

async function apiJson<T>(path: string): Promise<T> {
	const response = await apiResponse(path);
	if (!response.ok) error(response.status, `Console API returned ${String(response.status)}`);
	return (await response.json()) as T;
}

export interface WantedBoardSnapshot {
	readonly cards: CardItem[];
	readonly observed_at: string | null;
	readonly dispatcher_live: boolean;
	readonly tracker_live: boolean;
}

export const getWantedBoard = query(async (): Promise<WantedBoardSnapshot> => {
	if (isMock())
		return {
			cards: mockWanted,
			observed_at: new Date().toISOString(),
			dispatcher_live: true,
			tracker_live: true,
		};
	const [cards, executors] = await Promise.all([
		apiJson<ReadEnvelope<CardItem>>("/cards?limit=1000"),
		apiJson<ReadEnvelope<ExecutorItem>>("/executors"),
	]);
	const alive = (kind: ExecutorItem["kind"]) =>
		executors.items.some((executor) => executor.kind === kind && executor.liveness === "alive");
	return {
		cards: cards.items,
		observed_at: cards.freshness.observed_at,
		dispatcher_live: alive("dispatcher"),
		tracker_live: alive("tracker"),
	};
});

export const claimWantedCard = command(Schema.toStandardSchemaV1(claimArgs), async (input) => {
	if (isMock()) {
		return { won: true as const, task_id: input.task_id, claimed_by: "you" };
	}
	// Re-read immediately before the command. This is not the CAS (the tracker is); it prevents a
	// stale or mismatched dispatcher row from authorizing a claim for a different task id.
	const snapshot = await apiJson<ReadEnvelope<CardItem>>("/cards?limit=1000");
	const current = snapshot.items.find((card) => card.card_id === input.card_id);
	if (
		!current ||
		current.task_id !== input.task_id ||
		current.updated_at_ms !== input.updated_at_ms ||
		current.state !== "posted"
	) {
		void getWantedBoard().refresh();
		return {
			won: false as const,
			claimed_by: current?.claimed_by ?? null,
		};
	}
	const response = await apiResponse("/op", {
		method: "POST",
		headers: forwardedHeaders(true),
		body: JSON.stringify({
			schema_version: 1,
			id: crypto.randomUUID(),
			op: "task.claim",
			args: {
				id: input.task_id,
				...(input.capability ? { capability: input.capability } : {}),
			},
			task_id: input.task_id,
			dry_run: false,
		}),
	});
	const result = (await response.json().catch(() => null)) as OpResult | null;
	if (!response.ok || !result?.ok) {
		if (result?.error?.code === "claim_lost") {
			void getWantedBoard().refresh();
			return { won: false as const, claimed_by: null };
		}
		error(response.status || 500, result?.error?.message ?? "Wanted card could not be claimed");
	}
	void getWantedBoard().refresh();
	return { won: true as const, task_id: input.task_id, claimed_by: "you" };
});
