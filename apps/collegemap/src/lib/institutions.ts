/**
 * The vocabulary of affiliation, shared by the client and the server.
 *
 * A person is on this map because of somewhere they have to be. That used to mean a college and
 * nothing else; it now also means a unit, a job, or somewhere that fits none of those. All four are
 * places, so all four live in one table with a `kind` beside them rather than in parallel tables —
 * one column, and every join and render path that already existed keeps working.
 *
 * Lives outside `$lib/server` because the picker in the profile needs the same list the schema
 * enumerates, and a component may not import server code.
 */

export const INSTITUTION_KINDS = ["college", "military", "work", "other"] as const;

export type InstitutionKind = (typeof INSTITUTION_KINDS)[number];

/** What the picker calls each kind. */
export const INSTITUTION_KIND_LABELS: Record<InstitutionKind, string> = {
	college: "College",
	military: "Military",
	work: "Work",
	other: "Other",
};

/**
 * The line under each choice.
 *
 * Each one says exactly what the app will and will not fill in, because that is the difference
 * between the kinds that matters: what shows up on the calendar without you touching it.
 */
export const INSTITUTION_KIND_HINTS: Record<InstitutionKind, string> = {
	college: "Your college's published academic calendar fills itself in.",
	military: "US federal holidays are filled in as a default. Duty and leave are yours to add.",
	work: "US federal holidays are filled in as a default. Shifts and leave are yours to add.",
	other: "Nothing is assumed. Only the dates you enter show up.",
};

/** What the search box asks for, per kind. */
export const INSTITUTION_SEARCH_PLACEHOLDERS: Record<InstitutionKind, string> = {
	college: "Search for your college...",
	military: "Name your base or post...",
	work: "Name your workplace...",
	other: "Name the place...",
};

/**
 * The kinds for which the app falls back to the US federal holiday calendar.
 *
 * Only these two. A college has a real published calendar to follow, and `other` has asked for
 * nothing to be assumed, so inventing days off for either would be worse than leaving them blank.
 */
export const FEDERAL_HOLIDAY_KINDS: ReadonlySet<InstitutionKind> = new Set(["military", "work"]);

/**
 * Where a break shown on the calendar came from. Strongest first:
 *
 * - `user` — the person entered it. Only these are theirs to delete.
 * - `college` — their institution published it, and it was transcribed with a citation.
 * - `default` — nobody said anything about this person at all. The app filled in the calendar that
 *   this _kind_ of place usually follows. It is a placeholder, never a claim.
 *
 * The three are not interchangeable, which is the whole reason this is one field with three values
 * rather than a boolean: a reader has to be able to tell a transcribed fact from a filled-in
 * guess.
 */
export type BreakSource = "user" | "college" | "default";

/**
 * The one source that is an assumption rather than a statement.
 *
 * Named, and compared against by name, so that "is this row a guess?" is a single question with a
 * single answer everywhere it is asked.
 */
export const ASSUMED_SOURCE: BreakSource = "default";

/** True only for one of the four kinds. Form input arrives as an arbitrary string. */
export function isInstitutionKind(value: unknown): value is InstitutionKind {
	return typeof value === "string" && (INSTITUTION_KINDS as readonly string[]).includes(value);
}
