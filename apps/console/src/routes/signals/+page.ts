import type { SignalEmission } from "$lib/api/types";
import { mockCards, mockSignals, mockSubscriptions } from "$lib/data/signals";
import { dataMode, readCards, readExecutors, readSubscriptions, runQuery } from "$lib/rpc/browser";

import { formatUnknown } from "#format";

import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ fetch, parent }) => {
	const shell = await parent();
	if (dataMode() === "mock")
		return {
			isMock: true,
			signals: mockSignals,
			subscriptions: mockSubscriptions,
			cards: mockCards,
			errors: [],
			lanes: shell.me.lanes,
			consoleLive: true,
			dispatcherLive: true,
		};
	const errors: string[] = [];
	const [subs, cards, executors, history] = await Promise.all([
		readSubscriptions(fetch).catch(() => (errors.push("Subscription store unavailable"), null)),
		readCards(fetch).catch(() => (errors.push("Wanted board unavailable"), null)),
		readExecutors(fetch).catch(() => null),
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
			host: row[8] == null ? null : formatUnknown(row[8]),
			agent: row[9] == null ? null : formatUnknown(row[9]),
		},
	}));
	const alive = (kind: string) =>
		(executors?.items ?? []).some((e) => e.kind === kind && e.liveness === "alive");
	return {
		isMock: false,
		signals,
		subscriptions: subs?.items ?? [],
		cards: cards?.items ?? [],
		errors,
		lanes: shell.me.lanes,
		consoleLive: alive("console-api"),
		dispatcherLive: alive("dispatcher"),
	};
};
