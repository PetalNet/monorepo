import { getRequestEvent } from "$app/server";
import type {
	ConsoleHealth,
	DeliveryItem,
	ExecutorItem,
	OpResult,
	QueryResult,
	ReadEnvelope,
	SubscriptionItem,
} from "$lib/api/types";
import { publicConfig } from "$lib/config";
import {
	mockDelivery,
	mockReceipts,
	mockSubscriptions,
	type DeliveryReceiptView,
} from "$lib/data/signals";
import { ISO_DATETIME_OFFSET_RE, rejectUnknownKeys } from "$lib/server/domain/schema-conventions";
import { error } from "@sveltejs/kit";
import { Effect, Schema } from "effect";
import { Command, Query } from "svelte-effect-runtime";

import { formatUnknown } from "#format";

export interface DeliverySurfaceData {
	delivery: DeliveryItem | null;
	receipts: DeliveryReceiptView[];
	receiptsAvailable: boolean;
	matrixSyncOkEpoch: number | null;
	busObservedAt: string | null;
	loudSubscriptionCount: number;
	executorLive: boolean;
	executorDetail: string | null;
	errors: string[];
	isMock: boolean;
}

let mockDeliveryState: DeliveryItem = { ...mockDelivery };
let mockReceiptState: DeliveryReceiptView[] = [...mockReceipts];

function isMock(): boolean {
	return publicConfig.dataMode === "mock";
}

function apiBase(): string {
	return publicConfig.consoleApiBase ?? `${getRequestEvent().url.origin}/api/v1`;
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
		const body = (await response.json().catch(() => null)) as
			| { error?: { message?: string } }
			| OpResult
			| null;
		const message = body?.error?.message ?? `Console API returned ${String(response.status)}`;
		error(response.status, message);
	}
	return (await response.json()) as T;
}

const receiptQuery = {
	schema_version: 1,
	mode: "structured",
	from: "delivery.receipt",
	select: [
		{ field: "seq" },
		{ field: "ts" },
		{ field: "tier" },
		{ field: "signal_ref" },
		{ field: "subject" },
		{ field: "status" },
		{ field: "error_code" },
		{ field: "retryable" },
		{ field: "channel" },
	],
	order: [{ field: "seq", dir: "desc" }],
	limit: 50,
} as const;

export const getDeliverySurface = Query(
	Effect.promise(async (): Promise<DeliverySurfaceData> => {
		if (isMock())
			return {
				delivery: mockDeliveryState,
				receipts: mockReceiptState,
				receiptsAvailable: true,
				matrixSyncOkEpoch: Math.floor(Date.now() / 1_000),
				busObservedAt: new Date().toISOString(),
				loudSubscriptionCount: mockSubscriptions.filter((subscription) => subscription.loud).length,
				executorLive: true,
				executorDetail: "mock delivery executor",
				errors: [],
				isMock: true,
			};

		const errors: string[] = [];
		const settled = await Promise.allSettled([
			apiJson<ReadEnvelope<DeliveryItem>>("/delivery?limit=10"),
			apiJson<ReadEnvelope<SubscriptionItem>>("/subscriptions?limit=1000"),
			apiJson<ReadEnvelope<ExecutorItem>>("/executors"),
			apiJson<ConsoleHealth & { ingest?: { last_ingest_at: string }[] }>("/health"),
			apiJson<QueryResult>("/query", {
				method: "POST",
				headers: forwardedHeaders(true),
				body: JSON.stringify(receiptQuery),
			}),
		]);
		const value = (index: number, label: string): unknown => {
			const result = settled[index];
			if (result.status === "fulfilled") return result.value;
			errors.push(label);
			return null;
		};
		const delivery = value(0, "Delivery config unavailable") as ReadEnvelope<DeliveryItem> | null;
		const subscriptions = value(
			1,
			"Subscriptions unavailable",
		) as ReadEnvelope<SubscriptionItem> | null;
		const executors = value(
			2,
			"Executor evidence unavailable",
		) as ReadEnvelope<ExecutorItem> | null;
		const health = value(3, "Line health unavailable") as
			| (ConsoleHealth & { ingest?: { last_ingest_at: string }[] })
			| null;
		const receiptResult = value(4, "Delivery receipt query failed") as QueryResult | null;
		const receipts: DeliveryReceiptView[] = (receiptResult?.rows ?? []).map((row) => ({
			seq: String(row[0]),
			ts: String(row[1]),
			tier: String(row[2]),
			signal: String(row[3]),
			subject: formatUnknown(row[4] ?? ""),
			status: String(row[5]),
			error: row[6] == null ? null : formatUnknown(row[6]),
			retryable: row[7] === true || row[7] === "true",
			channel: row[8] == null ? "matrix" : formatUnknown(row[8]),
		}));
		const executor = executors?.items.find((item) => item.kind === "console-api") ?? null;
		const busObservedAt =
			health?.ingest
				?.map((item) => item.last_ingest_at)
				.toSorted()
				.at(-1) ?? null;
		return {
			delivery: delivery?.items[0] ?? null,
			receipts,
			receiptsAvailable: receiptResult !== null,
			matrixSyncOkEpoch: health?.matrix_sync_ok_epoch ?? null,
			busObservedAt,
			loudSubscriptionCount:
				subscriptions?.items.filter((subscription) => subscription.loud).length ?? 0,
			executorLive: executor?.liveness === "alive",
			executorDetail: executor?.detail ?? null,
			errors,
			isMock: false,
		};
	}),
);

async function runDeliveryOp(
	op: "delivery.test" | "delivery.set_target" | "delivery.resend" | "delivery.cocoon",
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const result = await apiJson<OpResult>("/op", {
		method: "POST",
		headers: forwardedHeaders(true),
		body: JSON.stringify({
			schema_version: 1,
			id: crypto.randomUUID(),
			op,
			args,
			dry_run: false,
		}),
	});
	if (!result.ok) error(400, result.error.message);
	void Effect.runPromise(getDeliverySurface().refresh());
	return result.result ?? {};
}

export const sendDeliveryTest = Command(() =>
	Effect.promise(async () => {
		if (isMock()) {
			const ts = new Date().toISOString();
			mockReceiptState = [
				{
					seq: `mock-${String(Date.now())}`,
					ts,
					tier: "test",
					signal: "delivery.test",
					subject: "Test from the lab.",
					status: "delivered",
					error: null,
					channel: "matrix",
				},
				...mockReceiptState,
			];
			void Effect.runPromise(getDeliverySurface().refresh());
			return { delivered: true, receipt_ref: mockReceiptState[0].seq };
		}
		return runDeliveryOp("delivery.test", {});
	}),
);

const targetArgs = Schema.Struct({
	target: Schema.String.check(Schema.isPattern(/^(@|!)[^:]+:.+$/), Schema.isMaxLength(255)),
}).annotate(rejectUnknownKeys);
export const setDeliveryTarget = Command(targetArgs, ({ target }) =>
	Effect.promise(async () => {
		if (isMock()) {
			mockDeliveryState = {
				...mockDeliveryState,
				target,
				verified: true,
				updated_at: new Date().toISOString(),
				updated_by: "parker",
			};
			void Effect.runPromise(getDeliverySurface().refresh());
			return { delivered: true, target, receipt_ref: `mock-${String(Date.now())}` };
		}
		return runDeliveryOp("delivery.set_target", { channel: "matrix", target });
	}),
);

const cocoonArgs = Schema.Struct({
	until: Schema.String.check(Schema.isPattern(ISO_DATETIME_OFFSET_RE)),
}).annotate(rejectUnknownKeys);
export const setDeliveryCocoon = Command(cocoonArgs, ({ until }) =>
	Effect.promise(async () => {
		if (isMock()) {
			mockDeliveryState = {
				...mockDeliveryState,
				cocoon_until: Date.parse(until) <= Date.now() ? null : until,
				updated_at: new Date().toISOString(),
				updated_by: "parker",
			};
			void Effect.runPromise(getDeliverySurface().refresh());
			return { cocoon_until: mockDeliveryState.cocoon_until };
		}
		return runDeliveryOp("delivery.cocoon", { until });
	}),
);

const resendArgs = Schema.Struct({
	receiptRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}).annotate(rejectUnknownKeys);
export const resendDeliveryReceipt = Command(resendArgs, ({ receiptRef }) =>
	Effect.promise(async () => {
		if (isMock()) return Effect.runPromise(sendDeliveryTest());
		return runDeliveryOp("delivery.resend", { receipt_ref: receiptRef });
	}),
);
