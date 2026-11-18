import { worst, type KevEntry } from "../kev";
import type { ServiceRow } from "../status/board";
import type { Store } from "../store";
import { addDays } from "../weekly";
import { dependencies, parseDomain, records, systemDns, type Dns, type Sign } from "./lookup";

/** Exploited vulnerabilities count against a provider for this many days after CISA lists them. */
const KEV_DAYS = 30;
/** No more lookups than this in any minute, whoever asks. */
const PER_MINUTE = 20;

export interface Finding {
	id: string;
	name: string;
	signs: Sign[];
	/** The provider's row on the status board, when it has one with a current reading. */
	status: Pick<ServiceRow, "verdict" | "claim" | "probe" | "page"> | undefined;
	/** Entries CISA added to its exploited list for this vendor in the last 30 days. */
	exploited: { count: number; worst: Pick<KevEntry, "cveId" | "name" | "dateAdded"> | undefined };
	/**
	 * Whether this panel can say anything about the provider: it has a current status reading or a
	 * name on CISA's list. A provider that is not tracked is neither a hit nor clear.
	 */
	tracked: boolean;
	/** Set by code: the provider reports trouble now, or has a recent exploited vulnerability. */
	hit: boolean;
}

export type HitCheck =
	| { kind: "idle" }
	| { kind: "invalid" }
	| { kind: "busy" }
	| { kind: "missing"; domain: string }
	| { kind: "failed"; domain: string }
	| { kind: "result"; domain: string; findings: Finding[]; checkedAt: string };

let recent: number[] = [];

function allowed(now: Date): boolean {
	const time = now.getTime();

	// Only the last minute counts, whichever way the clock has moved since.
	recent = recent.filter((earlier) => earlier > time - 60_000 && earlier <= time);

	if (recent.length >= PER_MINUTE) {
		return false;
	}

	recent.push(time);

	return true;
}

/**
 * "Does it hit me?": what public DNS shows a domain depends on, set against the status board and
 * CISA's exploited list. This app neither stores nor logs the typed domain.
 */
export async function hitCheck(
	store: Store,
	rows: readonly ServiceRow[],
	input: string | null,
	date: string,
	now: Date,
	dns: Dns = systemDns,
): Promise<HitCheck> {
	if (input === null || input.trim() === "") {
		return { kind: "idle" };
	}

	const domain = parseDomain(input);

	if (domain === undefined) {
		return { kind: "invalid" };
	}

	if (!allowed(now)) {
		return { kind: "busy" };
	}

	const found = await records(domain, dns);

	if (found === "missing" || found === "failed") {
		return { kind: found, domain };
	}

	const listed = store.addedBetween(addDays(date, 1 - KEV_DAYS), date);
	const findings = dependencies(found).map((dependency): Finding => {
		const vendors = new Set(dependency.vendors.map((vendor) => vendor.toLowerCase()));
		const entries = listed.filter((entry) => vendors.has(entry.vendor.toLowerCase()));
		const row = rows.find((candidate) => candidate.id === dependency.board);
		const top = worst(entries);
		const trouble =
			row !== undefined &&
			((row.claim !== undefined && row.claim.level !== "ok") || row.verdict === "differ");

		return {
			id: dependency.id,
			name: dependency.name,
			signs: dependency.signs,
			status: row && { verdict: row.verdict, claim: row.claim, probe: row.probe, page: row.page },
			exploited: {
				count: entries.length,
				worst: top && { cveId: top.cveId, name: top.name, dateAdded: top.dateAdded },
			},
			tracked: row?.claim !== undefined || vendors.size > 0,
			hit: trouble || entries.length > 0,
		};
	});

	return {
		kind: "result",
		domain,
		// The ones that hit come first.
		findings: findings.toSorted((a, b) => Number(b.hit) - Number(a.hit)),
		checkedAt: now.toISOString(),
	};
}
