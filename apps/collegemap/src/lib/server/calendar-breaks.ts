/**
 * Merging the two kinds of break the calendar shows.
 *
 * A person is off for two independent reasons: dates they entered themselves, and their college's
 * academic calendar. Both belong on the grid, so this unions them rather than letting one stand in
 * for the other. Kept pure and separate from the load so the union itself is testable.
 */

/** What the calendar grid and the editor consume. */
export interface CalendarBreakRow {
	id: string;
	userId: string;
	label: string;
	startDate: string;
	endDate: string;
	/** `user` rows are the person's own and are theirs to delete; `college` rows are institutional. */
	source: "user" | "college";
}

interface Person {
	id: string;
	collegeId: string | null;
}

interface UserBreak {
	id: string;
	userId: string;
	label: string;
	startDate: string;
	endDate: string;
}

interface CollegeBreak {
	id: string;
	collegeId: string;
	label: string;
	startDate: string;
	endDate: string;
}

export function mergeBreakRows(
	people: Person[],
	userBreaks: UserBreak[],
	collegeBreaks: CollegeBreak[],
): CalendarBreakRow[] {
	const byCollege = new Map<string, CollegeBreak[]>();
	for (const collegeBreak of collegeBreaks) {
		const list = byCollege.get(collegeBreak.collegeId);
		if (list) list.push(collegeBreak);
		else byCollege.set(collegeBreak.collegeId, [collegeBreak]);
	}

	// One institutional row becomes one row per person at that college, so the id has to carry the
	// person too — otherwise the same id appears many times in a list that is keyed by it.
	const institutional = people.flatMap((person) =>
		(person.collegeId ? (byCollege.get(person.collegeId) ?? []) : []).map((collegeBreak) => ({
			id: `${collegeBreak.id}:${person.id}`,
			userId: person.id,
			label: collegeBreak.label,
			startDate: collegeBreak.startDate,
			endDate: collegeBreak.endDate,
			source: "college" as const,
		})),
	);

	const own = userBreaks.map((userBreak) => ({
		id: userBreak.id,
		userId: userBreak.userId,
		label: userBreak.label,
		startDate: userBreak.startDate,
		endDate: userBreak.endDate,
		source: "user" as const,
	}));

	return [...own, ...institutional];
}
