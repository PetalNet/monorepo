import type { Store } from "./store";
import { weekly, type Gauge } from "./weekly";

/**
 * Emergency alerts that are not about weather, as US authorities broadcast them through the
 * National Weather Service. These are the alert system's own event names.
 */
const ALERT_EVENTS = [
	"911 Telephone Outage",
	"Civil Danger Warning",
	"Civil Emergency Message",
	"Evacuation Immediate",
	"Hazardous Materials Warning",
	"Law Enforcement Warning",
	"Local Area Emergency",
	"Nuclear Power Plant Warning",
	"Radiological Hazard Warning",
	"Shelter In Place Warning",
] as const;
const ALERT_SOURCE = "alerts";
/** The service keeps seven days of alerts, so the first pull reaches back this far. */
const WINDOW_DAYS = 7;

/** The public-safety dial compares the last seven days with the 12 weeks before them. */
const ALERT_WEEKS = 12;

export interface Alert {
	id: string;
	event: string;
	/** When the alert was sent. */
	sent: string;
	area: string;
	headline: string;
}

function alertsUrl(now: Date): string {
	const query = new URLSearchParams({
		event: ALERT_EVENTS.join(","),
		start: new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString(),
		status: "actual",
		message_type: "alert",
	});

	return `https://api.weather.gov/alerts?${query.toString()}`;
}

function field(properties: Record<string, unknown>, key: string): string {
	const value = properties[key];

	if (typeof value !== "string" || value === "") {
		throw new TypeError(`alerts feed: bad ${key}`);
	}

	return value;
}

/**
 * Parses the alert list. Only a first, real alert for one of our event names is kept: an update or
 * a cancellation of an alert is not a new incident, and tests and exercises are not incidents.
 */
function parseAlerts(body: unknown): Alert[] {
	const { features } = (body ?? {}) as { features?: unknown };

	if (!Array.isArray(features)) {
		throw new TypeError("alerts feed: no features array");
	}

	const events = new Set<string>(ALERT_EVENTS);

	return (features as { properties?: Record<string, unknown> }[]).flatMap(({ properties = {} }) => {
		if (
			properties.status !== "Actual" ||
			properties.messageType !== "Alert" ||
			typeof properties.event !== "string" ||
			!events.has(properties.event)
		) {
			return [];
		}

		const sent = field(properties, "sent");

		if (Number.isNaN(Date.parse(sent))) {
			throw new TypeError("alerts feed: bad sent");
		}

		return [
			{
				id: field(properties, "id"),
				event: properties.event,
				sent: new Date(sent).toISOString(),
				area: field(properties, "areaDesc"),
				headline: typeof properties.headline === "string" ? properties.headline : properties.event,
			},
		];
	});
}

/** One pull. Alerts are kept, so our record outlives the service's seven-day window. */
export async function ingestAlerts(
	store: Store,
	fetcher: typeof fetch = fetch,
	now = new Date(),
): Promise<number> {
	const response = await fetcher(alertsUrl(now), {
		headers: { "User-Agent": "chaos-tracker (status check)", Accept: "application/geo+json" },
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`alerts feed answered ${String(response.status)}`);
	}

	const alerts = parseAlerts(await response.json());

	store.saveAlerts(alerts, new Date(now.getTime() - WINDOW_DAYS * 86_400_000), now);

	return alerts.length;
}

/** Alerts are pulled hourly, so a check older than this means pulls are failing. */
const FRESH = 3 * 60 * 60 * 1000;

export interface PublicSafety {
	gauge: Gauge;
	/** Alerts sent in the last seven days, newest first. */
	recent: Alert[];
	checkedAt: string | undefined;
}

/**
 * Alerts sent in the seven days ending on `date` (a door-clock day, `dayOf` maps an instant to
 * one), against the weeks our own record covers. The record starts seven days before the first
 * pull, so the dial has no needle until 13 weeks have been collected.
 */
export function publicSafety(
	store: Store,
	date: string,
	now: Date,
	dayOf: (instant: Date) => string,
): PublicSafety {
	const source = store.source(ALERT_SOURCE);
	const recent = store.alertsSince(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));

	if (!source?.since || now.getTime() - Date.parse(source.checkedAt) > FRESH) {
		return { gauge: { of: ALERT_WEEKS, kind: "stale" }, recent: [], checkedAt: source?.checkedAt };
	}

	const counts = (from: string, to: string): Map<string, number> => {
		const byDay = new Map<string, number>();

		for (const alert of store.alertsSince(new Date(`${from}T00:00:00Z`))) {
			const day = dayOf(new Date(alert.sent));

			if (day >= from && day <= to) {
				byDay.set(day, (byDay.get(day) ?? 0) + 1);
			}
		}

		return byDay;
	};

	return {
		gauge: weekly(counts, dayOf(new Date(source.since)), date, ALERT_WEEKS),
		recent,
		checkedAt: source.checkedAt,
	};
}
