import { FRIENDSGIVING_POTLUCK } from "$lib/potluck";
import { describe, expect, it } from "vitest";

import { isBusyTransaction, oneSignupAtATime, potluckView } from "./potluck";

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

	it("sends counts but no dishes or names when the question is not public", () => {
		const view = potluckView(config, responses, false);

		expect(view.taken).toEqual([]);
		expect(view.counts).toEqual({ sides: 1, desserts: 1 });

		expect(potluckView(config, responses, true).taken.map((t) => t.name)).toEqual([
			"Avery",
			"Jordan",
		]);
	});
});

describe("isBusyTransaction", () => {
	it("recognises Prisma's transaction timeout and SQLite lock errors only", () => {
		for (const code of ["P1008", "P2024", "P2028", "P2034"]) {
			expect(isBusyTransaction(Object.assign(new Error("busy"), { code })), code).toBe(true);
		}

		expect(isBusyTransaction(new Error("SQLITE_BUSY: database is locked"))).toBe(true);

		expect(
			isBusyTransaction(Object.assign(new Error("Unique constraint"), { code: "P2002" })),
		).toBe(false);

		expect(isBusyTransaction(null)).toBe(false);
	});
});

describe("oneSignupAtATime", () => {
	it("runs one event's signups in order, never overlapping, and survives a failure", async () => {
		const log: string[] = [];
		let running = 0;
		const job =
			(name: string, fail = false) =>
			async () => {
				running++;
				expect(running).toBe(1);
				log.push(`start ${name}`);

				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});

				log.push(`end ${name}`);
				running--;

				if (fail) {
					throw new Error(name);
				}

				return name;
			};

		const results = await Promise.allSettled([
			oneSignupAtATime("e1", job("a")),
			oneSignupAtATime("e1", job("b", true)),
			oneSignupAtATime("e1", job("c")),
		]);

		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
		expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
	});
});
