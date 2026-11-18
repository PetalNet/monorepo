import type { Store } from "../store";
import { SERVICES, type ClaimLevel } from "./services";

/**
 * A reading older than this is not shown as current. Each window allows one failed round before the
 * reading drops out: rounds run every ten minutes, and a heavy feed is read once an hour.
 */
const FRESH = 25 * 60 * 1000;
const SLOW_FRESH = 130 * 60 * 1000;
/** One failed probe can be a blip. Two in a row is a failing probe. */
const FAILING_AFTER = 2;

export type Verdict =
	/** The page and the probe tell the same story. */
	| "agree"
	/**
	 * The page says all is well and our probe cannot get through, or the page reports an outage and
	 * it can.
	 */
	| "differ"
	/** The page reports partial trouble or maintenance and our probe still gets through. */
	| "partial"
	/** One failed probe so far. */
	| "retrying"
	/** One side has no current reading. */
	| "unknown";

export interface ServiceRow {
	id: string;
	name: string;
	page: string;
	/** The host our probe asks. */
	target: string;
	claim: { level: ClaimLevel; text: string; checkedAt: string } | undefined;
	probe: { reachable: boolean; detail: string; fails: number; checkedAt: string } | undefined;
	verdict: Verdict;
}

export interface Board {
	rows: ServiceRow[];
	/**
	 * A third or more of our probes fail at once: the fault is more likely our own network than every
	 * service.
	 */
	blind: boolean;
	/** The oldest check behind the rows on show, so the board never looks fresher than it is. */
	checkedAt: string | undefined;
}

function verdictOf(claim: ServiceRow["claim"], probe: ServiceRow["probe"]): Verdict {
	if (!claim || !probe) {
		return "unknown";
	}

	if (!probe.reachable && probe.fails < FAILING_AFTER) {
		return "retrying";
	}

	if (claim.level === "ok") {
		return probe.reachable ? "agree" : "differ";
	}

	if (!probe.reachable) {
		return "agree";
	}

	return claim.level === "outage" ? "differ" : "partial";
}

const ORDER: Record<Verdict, number> = { differ: 0, retrying: 1, partial: 2, unknown: 3, agree: 4 };

export function board(store: Store, now: Date): Board {
	const fresh = (checkedAt: string, limit: number) => now.getTime() - Date.parse(checkedAt) < limit;
	const rows = SERVICES.map((service): ServiceRow => {
		const claim = store.claim(service.id);
		const probe = store.probe(service.id);

		return {
			id: service.id,
			name: service.name,
			page: service.page,
			target: new URL(service.probe).host,
			claim: claim && fresh(claim.checkedAt, service.slow ? SLOW_FRESH : FRESH) ? claim : undefined,
			probe: probe && fresh(probe.checkedAt, FRESH) ? probe : undefined,
			verdict: "unknown",
		};
	});
	const probed = rows.filter((row) => row.probe);
	// A third of the services failing at the same moment is far likelier to be our uplink or DNS
	// than that many separate outages.
	const blind =
		probed.length >= 4 && probed.filter((row) => !row.probe?.reachable).length * 3 >= probed.length;

	for (const row of rows) {
		// With our own network in doubt, a failed probe says nothing about the service.
		row.verdict = blind && !row.probe?.reachable ? "unknown" : verdictOf(row.claim, row.probe);
	}

	const times = rows
		.flatMap((row) => [row.claim?.checkedAt, row.probe?.checkedAt])
		.filter((time) => time !== undefined);

	return {
		rows: rows.toSorted((a, b) => ORDER[a.verdict] - ORDER[b.verdict]),
		blind,
		checkedAt: times.toSorted()[0],
	};
}
