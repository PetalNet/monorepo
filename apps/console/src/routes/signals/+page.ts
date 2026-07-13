import {
	dataMode,
	readCards,
	readDelivery,
	readExecutors,
	readHealth,
	readSubscriptions,
	runQuery,
} from "$lib/api/client";
import type { SignalEmission } from "$lib/api/types";
import {
	mockCards,
	mockDelivery,
	mockReceipts,
	mockSignals,
	mockSubscriptions,
	type DeliveryReceiptView,
} from "$lib/data/signals";

import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (dataMode() === "mock")
		return {
			isMock: true,
			signals: mockSignals,
			subscriptions: mockSubscriptions,
			delivery: mockDelivery,
			cards: mockCards,
			receipts: mockReceipts,
			receiptsAvailable: true,
			matrixSyncOkEpoch: Math.floor(Date.now() / 1000),
			errors: [],
			lanes: shell.me.lanes,
			consoleLive: true,
			dispatcherLive: true,
		};
	const errors: string[] = [];
	const [subs, delivery, cards, executors, health, history, receipts] = await Promise.all([
		readSubscriptions(fetch).catch(() => (errors.push("Subscription store unavailable"), null)),
		readDelivery(fetch).catch(() => (errors.push("Delivery config unavailable"), null)),
		readCards(fetch).catch(() => (errors.push("Wanted board unavailable"), null)),
		readExecutors(fetch).catch(() => null),
		readHealth(fetch).catch(() => null),
		runQuery(
			{
				schema_version: 1,
				mode: "structured",
				from: "events",
				select: [
					{ field: "seq" },
					{ field: "type" },
					{ field: "subject" },
					{ field: "severity" },
					{ field: "scope" },
					{ field: "task_id" },
					{ field: "ts" },
					{ field: "source.service" },
					{ field: "source.host" },
					{ field: "source.agent" },
				],
				time: { from: new Date(Date.now() - 864e5).toISOString() },
				order: [{ field: "seq", dir: "desc" }],
				limit: 50,
			},
			fetch,
		).catch(() => (errors.push("Signal history query failed"), null)),
		runQuery(
			{
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
				],
				order: [{ field: "seq", dir: "desc" }],
				limit: 50,
			},
			fetch,
		).catch(() => (errors.push("Delivery receipt query failed"), null)),
	]);
	const signals: SignalEmission[] = (history?.rows ?? []).map((row) => ({
		schema_version: 1,
		id: String(row[0]),
		type: String(row[1]),
		subject: String(row[2]),
		severity: row[3] as SignalEmission["severity"],
		scope: String(row[4]),
		task_id: typeof row[5] === "number" ? row[5] : null,
		ts: String(row[6]),
		source: {
			service: String(row[7]),
			host: row[8] == null ? null : String(row[8]),
			agent: row[9] == null ? null : String(row[9]),
		},
	}));
	const alive = (kind: string) =>
		(executors?.items ?? []).some((e) => e.kind === kind && e.liveness === "alive");
	const receiptViews: DeliveryReceiptView[] = (receipts?.rows ?? []).map((r) => ({
		seq: String(r[0]),
		ts: String(r[1]),
		tier: String(r[2]),
		signal: String(r[3]),
		subject: String(r[4] ?? ""),
		status: String(r[5]),
		error: r[6] == null ? null : String(r[6]),
		retryable: r[7] === true || r[7] === "true",
	}));
	return {
		isMock: false,
		signals,
		subscriptions: subs?.items ?? [],
		delivery: delivery?.items[0] ?? null,
		cards: cards?.items ?? [],
		receipts: receiptViews,
		receiptsAvailable: receipts !== null,
		matrixSyncOkEpoch: health?.matrix_sync_ok_epoch ?? null,
		errors,
		lanes: shell.me.lanes,
		consoleLive: alive("console-api"),
		dispatcherLive: alive("dispatcher"),
	};
};
