import { and, asc, eq, inArray, not } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import * as schema from "./db/schema";
import { MISSING_ACADEMIC_DATE } from "./college-breaks-constants";

type Database = LibSQLDatabase<typeof schema>;

/** The only institutional entries that mean students are away from campus. */
const RENDERED_KINDS = ["break", "holiday"] as const;

export async function getRenderedCollegeBreaks(database: Database, collegeId?: string) {
	const rendered = and(
		inArray(schema.collegeBreaks.kind, RENDERED_KINDS),
		not(eq(schema.collegeBreaks.startDate, MISSING_ACADEMIC_DATE)),
		not(eq(schema.collegeBreaks.endDate, MISSING_ACADEMIC_DATE)),
	);
	const where = collegeId ? and(eq(schema.collegeBreaks.collegeId, collegeId), rendered) : rendered;

	return database
		.select({
			id: schema.collegeBreaks.id,
			collegeId: schema.collegeBreaks.collegeId,
			label: schema.collegeBreaks.label,
			startDate: schema.collegeBreaks.startDate,
			endDate: schema.collegeBreaks.endDate,
			kind: schema.collegeBreaks.kind,
		})
		.from(schema.collegeBreaks)
		.where(where)
		.orderBy(asc(schema.collegeBreaks.startDate));
}
