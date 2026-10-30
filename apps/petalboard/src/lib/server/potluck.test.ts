import { FRIENDSGIVING_POTLUCK } from "$lib/potluck";
import { describe, expect, it } from "vitest";

import { isBusyTransaction, potluckView } from "./potluck";

const responses = [
	{
		value: JSON.stringify({ category: "sides", dish: "stuffing" }),
		rsvp: { name: "Avery", status: "attending" },
	},
	{
		value: JSON.stringify({ category: "desserts", dish: "pie" }),
		rsvp: { name: "Jordan", status: "maybe" },
	},
	{
		value: JSON.stringify({ category: "desserts", dish: "cake" }),
		rsvp: { name: "Sam", status: "not_attending" },
	},
];
const config = JSON.stringify(FRIENDSGIVING_POTLUCK);

describe("potluckView", () => {
	it("counts attending and maybe dishes and leaves out guests who can't come", () => {
		expect(potluckView(config, responses, true).counts).toEqual({ sides: 1, desserts: 1 });
	});

	it("hides every guest name when the question is not public", () => {
		const view = potluckView(config, responses, false);

		expect(view.taken.map((t) => t.name)).toEqual([null, null]);

		expect(potluckView(config, responses, true).taken.map((t) => t.name)).toEqual([
			"Avery",
			"Jordan",
		]);
	});
});

describe("isBusyTransaction", () => {
	it("recognises Prisma's transaction timeout and SQLite lock errors only", () => {
		expect(
			isBusyTransaction(Object.assign(new Error("Transaction API error"), { code: "P2028" })),
		).toBe(true);

		expect(isBusyTransaction(new Error("SQLITE_BUSY: database is locked"))).toBe(true);

		expect(
			isBusyTransaction(Object.assign(new Error("Unique constraint"), { code: "P2002" })),
		).toBe(false);

		expect(isBusyTransaction(null)).toBe(false);
	});
});
