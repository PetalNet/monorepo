/**
 * Which season a break belongs to.
 *
 * This exists only to tint the break-name chip and the small mark on a named day. It is a
 * _secondary_ channel and must stay one: a cell's fill still means free / not free, and no colour
 * decided here is allowed near it.
 *
 * The rule is name first, date second. The name wins because a break carries its season across a
 * boundary — "Winter Break" is winter on January 8th, and the start date alone would only agree
 * with that by accident. Where the name says nothing ("Labor Day", "No Classes"), the
 * meteorological season of the first day decides.
 */

export type Season = "autumn" | "spring" | "summer" | "winter";

/**
 * A break's name: everything before the first parenthesis, colon, or spaced dash.
 *
 * Institutional labels carry their provenance inline, and it runs long — "Winter break (gap between
 * fall exams ending and spring classes starting; WashU publishes no named 'winter break' entry)" is
 * one break called "Winter break". The tail is sourcing, so it belongs in a tooltip rather than in
 * the line a reader scans, and it is also what makes that entry name three seasons when it means
 * one.
 */
export function breakName(label: string): string {
	return label.split(/\s[-–—]\s|[(:]/u)[0].trim();
}

/**
 * Ordered because a head can hold two of these words. Winter is tried first: "Winter Interim"
 * outranks anything a trailing word could claim, and no autumn, spring, or summer break is named
 * after a later season.
 */
const NAME_RULES: readonly (readonly [RegExp, Season])[] = [
	[/winter|christmas|hanukkah|new year|yule/iu, "winter"],
	[/spring|easter|good friday|passover/iu, "spring"],
	[/summer/iu, "summer"],
	[/fall|autumn|thanksgiving|harvest|halloween/iu, "autumn"],
];

/** Meteorological seasons: Mar-May spring, Jun-Aug summer, Sep-Nov autumn, Dec-Feb winter. */
function seasonOfMonth(month1: number): Season {
	if (month1 >= 3 && month1 <= 5) return "spring";
	if (month1 >= 6 && month1 <= 8) return "summer";
	if (month1 >= 9 && month1 <= 11) return "autumn";
	return "winter";
}

/** The season a break belongs to. `startIso` is its first day, `YYYY-MM-DD`. */
export function deriveSeason(label: string, startIso: string): Season {
	const name = breakName(label);
	for (const [pattern, season] of NAME_RULES) {
		if (pattern.test(name)) return season;
	}
	return seasonOfMonth(Number(startIso.slice(5, 7)));
}
