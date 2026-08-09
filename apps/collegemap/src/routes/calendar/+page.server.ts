import { isIsoDate, todayIso, toDay } from "$lib/dates";
import { db } from "$lib/server/db";
import { breaks, colleges, users } from "$lib/server/db/schema";
import { formText } from "$lib/server/form";
import { fail } from "@sveltejs/kit";
import { and, asc, eq } from "drizzle-orm";

import type { Actions, PageServerLoad } from "./$types";

/** Long enough for "Thanksgiving break", short enough to stay on one line. */
const MAX_LABEL = 40;
/** A break longer than a year is a data-entry mistake, not a break. */
const MAX_SPAN_DAYS = 366;
const MAX_BREAKS_PER_PERSON = 40;

function initialsOf(first: string, last: string): string {
	return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export const load: PageServerLoad = async ({ locals }) => {
	const people = await db
		.select({
			id: users.id,
			firstName: users.firstName,
			lastName: users.lastName,
			collegeName: colleges.name,
		})
		.from(users)
		.leftJoin(colleges, eq(users.collegeId, colleges.id))
		.orderBy(asc(users.firstName), asc(users.lastName));

	const breakRows = await db
		.select({
			id: breaks.id,
			userId: breaks.userId,
			label: breaks.label,
			startDate: breaks.startDate,
			endDate: breaks.endDate,
		})
		.from(breaks)
		.orderBy(asc(breaks.startDate));

	return {
		people: people.map((p) => ({
			id: p.id,
			firstName: p.firstName,
			// Surname initial only: the dense views need something short, and the
			// full surname adds nothing when you already know these people.
			shortName: `${p.firstName} ${p.lastName.charAt(0)}.`,
			initials: initialsOf(p.firstName, p.lastName),
			collegeName: p.collegeName,
		})),
		breaks: breakRows,
		meId: locals.user?.id ?? null,
		todayIso: todayIso("America/New_York"),
	};
};

export const actions: Actions = {
	add: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: "Log in to add your breaks." });

		const form = await request.formData();
		const label = (formText(form, "label") ?? "").trim();
		const startDate = formText(form, "startDate") ?? "";
		const endDate = formText(form, "endDate") ?? "";

		if (!label) return fail(400, { error: "Give the break a name.", label, startDate, endDate });
		if (label.length > MAX_LABEL)
			return fail(400, {
				error: `Keep the name under ${String(MAX_LABEL)} characters.`,
				label,
				startDate,
				endDate,
			});
		if (!isIsoDate(startDate) || !isIsoDate(endDate))
			return fail(400, { error: "Pick a real start and end date.", label, startDate, endDate });

		const start = toDay(startDate);
		const end = toDay(endDate);
		if (end < start)
			return fail(400, {
				error: "The end date comes before the start date.",
				label,
				startDate,
				endDate,
			});
		if (end - start + 1 > MAX_SPAN_DAYS)
			return fail(400, {
				error: "That break is over a year long. Check the dates.",
				label,
				startDate,
				endDate,
			});

		const mine = await db
			.select({ id: breaks.id })
			.from(breaks)
			.where(eq(breaks.userId, locals.user.id));
		if (mine.length >= MAX_BREAKS_PER_PERSON)
			return fail(400, { error: "You have reached the maximum number of breaks." });

		await db.insert(breaks).values({ userId: locals.user.id, label, startDate, endDate });
		return { success: true };
	},

	remove: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: "Log in to change your breaks." });

		const form = await request.formData();
		const id = formText(form, "id") ?? "";
		if (!id) return fail(400, { error: "Missing break." });

		// Ownership lives in the WHERE clause, so someone else's id simply matches
		// no rows. There is no separate check to forget or bypass.
		await db.delete(breaks).where(and(eq(breaks.id, id), eq(breaks.userId, locals.user.id)));
		return { success: true };
	},
};
