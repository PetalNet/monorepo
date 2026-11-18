export const KEV_FEED =
	"https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

/** Every door item carries exactly one of these. Code sets it from the source, never a model. */
export type Cause = "attack" | "accident" | "unknown" | "unconfirmed";

/** CISA lists a vulnerability only on evidence of active exploitation. */
export const KEV_CAUSE: Cause = "attack";

export interface KevEntry {
	cveId: string;
	vendor: string;
	product: string;
	name: string;
	description: string;
	/** ISO dates as CISA publishes them. */
	dateAdded: string;
	dueDate: string;
	ransomware: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function field(row: Record<string, unknown>, key: string, pattern?: RegExp): string {
	const value = row[key];

	if (typeof value !== "string" || (pattern && !pattern.test(value))) {
		throw new Error(`KEV feed: bad ${key} in ${JSON.stringify(row.cveID)}`);
	}

	return value;
}

/**
 * Parses the feed body. One malformed row rejects the whole pull, so the store keeps its last good
 * copy.
 */
export function parseCatalog(body: unknown): KevEntry[] {
	const rows = (body as { vulnerabilities?: unknown } | null)?.vulnerabilities;

	if (!Array.isArray(rows)) {
		throw new Error("KEV feed: no vulnerabilities array");
	}

	return rows.map((row: Record<string, unknown>) => ({
		cveId: field(row, "cveID", /^CVE-\d{4}-\d+$/),
		vendor: field(row, "vendorProject"),
		product: field(row, "product"),
		name: field(row, "vulnerabilityName"),
		description: field(row, "shortDescription"),
		dateAdded: field(row, "dateAdded", ISO_DATE),
		dueDate: field(row, "dueDate", ISO_DATE),
		ransomware: field(row, "knownRansomwareCampaignUse") === "Known",
	}));
}

/**
 * The feed carries no severity score, so "worst" uses only what CISA states: known ransomware use
 * first, then the earliest remediation deadline, then CVE ID so the pick is stable.
 */
export function worst(entries: readonly KevEntry[]): KevEntry | undefined {
	return entries.toSorted(
		(a, b) =>
			Number(b.ransomware) - Number(a.ransomware) ||
			a.dueDate.localeCompare(b.dueDate) ||
			a.cveId.localeCompare(b.cveId),
	)[0];
}
