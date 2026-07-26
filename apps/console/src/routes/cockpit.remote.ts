import {
	attentionSort,
	consoleHealthBusAgeS,
	flattenRosterItem,
	healthVerdict,
	isActiveAttention,
	isRosterDown,
	rosterState,
	rosterTone,
	type JoinedRosterItem,
} from "$lib/api/derive";
import type {
	AttentionItem,
	ConsoleHealth,
	DashboardItem,
	Me,
	ReadEnvelope,
	RosterItem,
} from "$lib/api/types";
import { publicConfig } from "$lib/config";
import {
	crackMeta,
	crackStateFact,
	mockCockpit,
	type CockpitData,
	type NavBadges,
	type Scene,
} from "$lib/data/cockpit";
import { captureCaughtFailure } from "$lib/glitchtip";
import type { CaughtFailureEndpoint } from "$lib/glitchtip-reporter";
import { readPlaneRemote } from "$lib/operations.remote";
import { Effect } from "effect";
import { Error as HttpError, Query, RequestEvent } from "svelte-effect-runtime";

export interface CockpitRemoteResult {
	readonly cockpit: CockpitData;
	readonly isMock: boolean;
	readonly staleSources: readonly string[];
}

function sceneFromUrl(url: URL): Scene {
	const scene = url.searchParams.get("scene");
	return scene === "busy" || scene === "crack" || scene === "asked" ? scene : "clear";
}

const readOrNull = <A>(effect: Effect.Effect<A, unknown>, endpoint: CaughtFailureEndpoint) =>
	effect.pipe(
		Effect.catch((cause) => {
			captureCaughtFailure(cause, { surface: "cockpit", endpoint });
			return Effect.succeed(null);
		}),
	);

/** Server-side cockpit RPC. Browser code never assembles console-api requests or crack truth. */
export const getCockpit = Query(
	Effect.gen(function* () {
		if (publicConfig.dataMode === "mock") {
			const event = yield* RequestEvent;
			return { cockpit: mockCockpit(sceneFromUrl(event.url)), isMock: true, staleSources: [] };
		}
		const [attentionRead, rosterRead, healthRead, dashboardsRead, meRead] = (yield* Effect.all(
			[
				readOrNull(readPlaneRemote("attention"), "/attention"),
				readOrNull(readPlaneRemote("roster"), "/roster"),
				readOrNull(readPlaneRemote("health"), "/health"),
				readOrNull(readPlaneRemote("dashboards"), "/dashboards"),
				readOrNull(readPlaneRemote("me"), "/me"),
			],
			{ concurrency: "unbounded" },
		)) as [
			ReadEnvelope<AttentionItem> | null,
			ReadEnvelope<JoinedRosterItem> | null,
			ConsoleHealth | null,
			ReadEnvelope<DashboardItem> | null,
			Me | null,
		];
		if (!attentionRead && !rosterRead && !healthRead && !dashboardsRead)
			return yield* HttpError("ServiceUnavailable", "Cockpit sources are unavailable");
		const attention = attentionRead?.items ?? [];
		const roster: RosterItem[] = rosterRead?.items.map(flattenRosterItem) ?? [];
		const dashboards = dashboardsRead?.items ?? [];
		const now = Date.now();
		const active = attentionSort(attention.filter((item) => isActiveAttention(item, now)));
		const activeP0 = active.filter((item) => item.grade === "p0").length;
		const fleetClocks = roster.flatMap((row) =>
			row.fleet_updated_at ? [Date.parse(row.fleet_updated_at)] : [],
		);
		const fleetAgeS = fleetClocks.length ? (now - Math.max(...fleetClocks)) / 1_000 : null;
		const verdict = attentionRead
			? healthVerdict({
					busHeartbeatAgeS: healthRead ? consoleHealthBusAgeS(healthRead, now) : null,
					fleetSnapshotAgeS: rosterRead ? fleetAgeS : null,
					activeP0Count: activeP0,
					activeAttentionCount: active.length,
				})
			: "cant_verify";
		const hosts = new Map<string, RosterItem[]>();
		for (const row of roster) {
			if (!row.host) continue;
			hosts.set(row.host, [...(hosts.get(row.host) ?? []), row]);
		}
		const railHosts = [...hosts].map(([host, residents]) => {
			const states = residents.map((row) => rosterState(row, now));
			const dark = states.every(isRosterDown);
			return {
				host,
				workersUp: residents.reduce((count, row) => count + row.workers_active, 0),
				dark,
				tone: dark
					? ("danger" as const)
					: states.some((state) => rosterTone(state) === "warn")
						? ("warn" as const)
						: ("good" as const),
			};
		});
		const needsNew = active.filter((item) => !item.acked_by).length;
		const needsHeld = active.length - needsNew;
		const badges: NavBadges = {
			"/": activeP0 > 0 ? "p0" : active.length > 0 ? "warn" : null,
			"/work": active.filter((item) => item.grade === "review").length || null,
			"/agents": roster.some((row) => isRosterDown(rosterState(row, now))) ? "down" : null,
			"/hosts": railHosts.some((host) => host.dark) ? "down" : null,
		};
		const staleSources = [
			attentionRead ? null : "attention",
			rosterRead ? null : "roster",
			healthRead ? null : "health",
			dashboardsRead ? null : "dashboards",
		].filter((source): source is string => source !== null);
		const stateFact =
			verdict === "cracked"
				? crackStateFact(active)
				: !attentionRead
					? "Can't verify. Attention read unavailable."
					: healthRead?.lake === "down"
						? "Telemetry lake unreachable."
						: staleSources.length > 0
							? `${staleSources.join(", ")} ${staleSources.length === 1 ? "read is" : "reads are"} stale.`
							: "Bus evidence unavailable.";

		return {
			isMock: false,
			staleSources,
			cockpit: {
				scene: "clear",
				greetingName: meRead?.display_name ?? meRead?.id ?? "Neighbor",
				connected: Boolean(attentionRead || rosterRead || healthRead || dashboardsRead),
				verdict,
				stateFact,
				crackMeta: crackMeta(active),
				badges,
				hud: {
					needsNew,
					needsHeld,
					inFlight: roster.filter((row) => rosterState(row, now) === "working").length,
					hostsUp: railHosts.filter((host) => !host.dark).length,
					hostsDown: railHosts.filter((host) => host.dark).length,
				},
				attention: active,
				railHosts,
				residents: roster,
				comms: [],
				saved: dashboards.map((dashboard) => ({
					id: dashboard.id,
					name: dashboard.title,
					sub: `${String(dashboard.panel_count)} panel${dashboard.panel_count === 1 ? "" : "s"}${dashboard.is_home ? " · home" : ""}`,
				})),
			},
		};
	}),
);
