import { browser } from "$app/environment";
import { dataMode, readAttention, readDashboards, readHealth, readRoster } from "$lib/api/client";
import {
	attentionSort,
	consoleHealthBusAgeS,
	healthVerdict,
	isActiveAttention,
	isRosterDown,
	rosterState,
} from "$lib/api/derive";
import type { AttentionItem, ConsoleHealth, DashboardItem, RosterItem } from "$lib/api/types";
import { mockCockpit, type CockpitData, type NavBadges } from "$lib/data/cockpit";
import { captureCaughtFailure } from "$lib/glitchtip";

import type { PageLoad } from "./$types";

/**
 * Cockpit data (foundations §4, §6.2). Live mode composes independent attention, roster, health,
 * and dashboard reads. Each source retains its own browser-scoped last-known value; failures never
 * replace a valid snapshot with an empty fixture.
 */
interface LiveCache {
	attention?: AttentionItem[];
	roster?: RosterItem[];
	health?: ConsoleHealth;
	dashboards?: DashboardItem[];
}
const lastKnown: LiveCache = {};

function keep<T extends keyof LiveCache>(key: T, value: LiveCache[T] | null): LiveCache[T] {
	if (value && browser) lastKnown[key] = value;
	return value ?? (browser ? lastKnown[key] : undefined);
}

export const load: PageLoad = async ({ parent, fetch }): Promise<{ cockpit: CockpitData }> => {
	const { scene, me } = await parent();
	if (dataMode() === "live") {
		const [attentionRead, rosterRead, healthRead, dashboardsRead] = await Promise.all([
			readAttention(fetch).catch((error) => {
				captureCaughtFailure(error, { surface: "cockpit", endpoint: "/attention" });
				return null;
			}),
			readRoster(fetch).catch((error) => {
				captureCaughtFailure(error, { surface: "cockpit", endpoint: "/roster" });
				return null;
			}),
			readHealth(fetch).catch((error) => {
				captureCaughtFailure(error, { surface: "cockpit", endpoint: "/health" });
				return null;
			}),
			readDashboards(fetch).catch((error) => {
				captureCaughtFailure(error, { surface: "cockpit", endpoint: "/dashboards" });
				return null;
			}),
		]);
		const attention = keep("attention", attentionRead?.items ?? null) ?? [];
		const roster = keep("roster", rosterRead?.items ?? null) ?? [];
		const health = keep("health", healthRead);
		const dashboards = keep("dashboards", dashboardsRead?.items ?? null) ?? [];
		const now = Date.now();
		const active = attentionSort(attention.filter((item) => isActiveAttention(item, now)));
		const activeP0 = active.filter((item) => item.grade === "p0").length;
		const fleetClocks = roster.flatMap((row) =>
			row.fleet_updated_at ? [Date.parse(row.fleet_updated_at)] : [],
		);
		const fleetAgeS = fleetClocks.length ? (now - Math.max(...fleetClocks)) / 1_000 : null;
		const verdict = healthVerdict({
			busHeartbeatAgeS: health ? consoleHealthBusAgeS(health, now) : null,
			fleetSnapshotAgeS: fleetAgeS,
			activeP0Count: activeP0,
			activeAttentionCount: active.length,
		});
		const hosts = new Map<string, RosterItem[]>();
		for (const row of roster) {
			if (!row.host) continue;
			hosts.set(row.host, [...(hosts.get(row.host) ?? []), row]);
		}
		const railHosts = [...hosts].map(([host, residents]) => ({
			host,
			workersUp: residents.reduce((count, row) => count + row.workers_active, 0),
			dark: residents.every((row) => isRosterDown(rosterState(row, now))),
		}));
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
				? (active[0]?.summary ?? null)
				: health?.lake === "down"
					? "Telemetry lake unreachable."
					: staleSources.length > 0
						? `${staleSources.join(", ")} ${staleSources.length === 1 ? "read is" : "reads are"} stale.`
						: "Bus evidence unavailable.";
		return {
			cockpit: {
				scene: "clear",
				greetingName: me.display_name ?? me.id,
				connected: Boolean(
					attentionRead ||
					rosterRead ||
					healthRead ||
					dashboardsRead ||
					Object.keys(lastKnown).length,
				),
				verdict,
				stateFact,
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
				comms: [],
				saved: dashboards.map((dashboard) => ({
					id: dashboard.id,
					name: dashboard.title,
					sub: `${dashboard.panel_count} panel${dashboard.panel_count === 1 ? "" : "s"}${dashboard.is_home ? " · home" : ""}`,
				})),
			},
		};
	}
	const healthScene = scene === "crack" ? "crack" : scene === "busy" ? "busy" : "clear";
	return { cockpit: mockCockpit(healthScene) };
};
