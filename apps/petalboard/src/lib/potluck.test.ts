import { describe, expect, it } from "vitest";

import {
	FRIENDSGIVING_POTLUCK,
	offeredCategoryIds,
	parsePotluckAnswer,
	slotStatuses,
	standings,
	type CategoryCounts,
	unclaimedIdeas,
	type PotluckConfig,
} from "./potluck";

const FRIENDSGIVING_CATEGORIES = FRIENDSGIVING_POTLUCK.categories;

const friendsgiving = (minOptions: number): PotluckConfig => ({
	...FRIENDSGIVING_POTLUCK,
	categories: FRIENDSGIVING_CATEGORIES.map((c) => ({ ...c })),
	minOptions,
});

/** Park-Miller: a seeded generator so the randomized test replays the same cases. */
function seeded(seed: number) {
	return () => {
		seed = (seed * 48_271) % 2_147_483_647;

		return seed / 2_147_483_647;
	};
}

function fill(
	config: PotluckConfig,
	guests: number,
	choose: (offered: string[]) => string,
): Record<string, number> {
	const counts: Record<string, number> = {};

	for (let i = 0; i < guests; i++) {
		const offered = offeredCategoryIds(config, counts);
		const pick = choose(offered);

		expect(offered).toContain(pick);
		counts[pick] = (counts[pick] ?? 0) + 1;
	}

	return counts;
}

const dessertOrWorst = (offered: string[]) =>
	offered.includes("desserts") ? "desserts" : offered[offered.length - 1];
const dessertOrTopSuggestion = (offered: string[]) =>
	offered.includes("desserts") ? "desserts" : offered[0];

describe("Friendsgiving defaults", () => {
	it("offer at least two categories by default", () => {
		expect(FRIENDSGIVING_POTLUCK.minOptions).toBe(2);
	});

	it("are the shares Parker set: sides 50, apps 20, desserts 20, drinks 10", () => {
		expect(Object.fromEntries(FRIENDSGIVING_CATEGORIES.map((c) => [c.label, c.ratio]))).toEqual({
			Sides: 50,
			"Apps & snacks": 20,
			Desserts: 20,
			Drinks: 10,
		});
	});
});

describe("standings", () => {
	it("offers every category before anything is signed up", () => {
		expect(offeredCategoryIds(friendsgiving(1), {}).toSorted()).toEqual([
			"apps-snacks",
			"desserts",
			"drinks",
			"sides",
		]);
	});

	it("closes a category that has reached its share", () => {
		const counts = { sides: 5, "apps-snacks": 2, desserts: 3, drinks: 1 };
		const desserts = standings(friendsgiving(1), counts).find((s) => s.category.id === "desserts");

		expect(desserts).toMatchObject({ cap: 3, reason: "closed" });
	});

	it("lists the most under-target category first", () => {
		const counts = { sides: 1, "apps-snacks": 2, desserts: 2, drinks: 1 };

		expect(offeredCategoryIds(friendsgiving(1), counts)[0]).toBe("sides");
	});

	it("keeps a dessert-only crowd within one dish of every share when minOptions is 1", () => {
		const config = friendsgiving(1);
		const counts = fill(config, 40, dessertOrWorst);

		for (const c of config.categories) {
			const share = c.ratio / 100;

			expect(Math.abs((counts[c.id] ?? 0) - share * 40)).toBeLessThanOrEqual(1);
		}
	});

	it("holds desserts near 20% with three options when every guest wants dessert", () => {
		const counts = fill(friendsgiving(3), 40, dessertOrTopSuggestion);

		expect(counts.desserts).toBeLessThanOrEqual(9);
		expect(counts.sides).toBeGreaterThanOrEqual(19);
	});

	it("never offers fewer than minOptions, and backfills with the closest-to-target categories", () => {
		const rand = seeded(7);

		for (let trial = 0; trial < 2000; trial++) {
			const minOptions = 1 + Math.floor(rand() * 4);
			const counts: CategoryCounts = Object.fromEntries(
				FRIENDSGIVING_CATEGORIES.map((c) => [c.id, Math.floor(rand() * 15)]),
			);
			const ranked = standings(friendsgiving(minOptions), counts);
			const offered = ranked.filter((s) => s.reason !== "closed");

			expect(offered.length).toBeGreaterThanOrEqual(minOptions);
			const backfilled = ranked.filter((s) => s.reason === "minimum");
			const stillClosed = ranked.filter((s) => s.reason === "closed");

			for (const b of backfilled) {
				for (const c of stillClosed) {
					expect(b.deficit).toBeGreaterThanOrEqual(c.deficit);
				}
			}

			if (backfilled.length > 0) {
				expect(offered.length).toBe(minOptions);
			}
		}
	});

	it("caps minOptions at the number of categories", () => {
		const counts = { sides: 9, "apps-snacks": 9, desserts: 9, drinks: 9 };

		expect(offeredCategoryIds(friendsgiving(10), counts)).toHaveLength(4);
	});

	it("reopens a category when one of its dishes is cancelled", () => {
		const config = friendsgiving(1);
		const full = { sides: 5, "apps-snacks": 2, desserts: 3, drinks: 1 };

		expect(offeredCategoryIds(config, full)).not.toContain("desserts");
		expect(offeredCategoryIds(config, { ...full, desserts: 2 })).toContain("desserts");
	});

	it("keeps a category closed when the cancellation was elsewhere", () => {
		const config = friendsgiving(1);
		const afterSideCancelled = { sides: 4, "apps-snacks": 2, desserts: 3, drinks: 1 };

		expect(offeredCategoryIds(config, afterSideCancelled)).not.toContain("desserts");
	});

	it("offers a category the host forced open even past its share", () => {
		const config = friendsgiving(1);

		config.categories.find((c) => c.id === "desserts")!.forceOpen = true;
		const counts = { sides: 2, "apps-snacks": 1, desserts: 9, drinks: 0 };
		const desserts = standings(config, counts).find((s) => s.category.id === "desserts");

		expect(desserts?.reason).toBe("forced");
	});

	it("ignores answers for categories the host has since removed", () => {
		const counts = { sides: 1, mains: 30 };

		expect(offeredCategoryIds(friendsgiving(1), counts)).toContain("desserts");
	});
});

describe("unclaimedIdeas", () => {
	it("hides ideas someone already signed up for, ignoring case and spacing", () => {
		const desserts = FRIENDSGIVING_CATEGORIES.find((c) => c.id === "desserts")!;
		const left = unclaimedIdeas(desserts, ["Pumpkin Pie ", "grandma's brownies"]);

		expect(left).not.toContain("pumpkin pie");
		expect(left).toContain("brownies");
		expect(left).toHaveLength(desserts.ideas.length - 1);
	});

	it("never suggests a dish the hosts are providing", () => {
		const hostDishes = [
			/pulled\s+chicken/,
			/pulled\s+pork/,
			/mac(aroni)?\s*(and|&|n'?)\s*cheese/,
			/green\s+beans?/,
		];
		const suggested = FRIENDSGIVING_CATEGORIES.flatMap((c) => c.ideas.map((i) => i.toLowerCase()));

		expect(suggested.filter((idea) => hostDishes.some((dish) => dish.test(idea)))).toEqual([]);
	});

	it("names the hosts' dishes in the default providing line", () => {
		expect(FRIENDSGIVING_POTLUCK.providing).toBe(
			"Pulled chicken and pork, mac and cheese, and green beans",
		);
	});
});

describe("slotStatuses", () => {
	const status = (counts: CategoryCounts) =>
		Object.fromEntries(
			slotStatuses(friendsgiving(1), counts).map((s) => [s.category.id, s.status]),
		);

	it("marks the most under-target category as needed most and full ones as full", () => {
		expect(status({ sides: 1, "apps-snacks": 2, desserts: 3, drinks: 1 })).toEqual({
			sides: "needed-most",
			"apps-snacks": "full",
			desserts: "full",
			drinks: "full",
		});
	});

	it("names nothing as needed most before any category is a whole dish behind", () => {
		expect(Object.values(status({}))).not.toContain("needed-most");
		expect(Object.values(status({}))).not.toContain("full");
	});

	it("lists categories most-needed first", () => {
		const order = slotStatuses(friendsgiving(1), {
			sides: 0,
			desserts: 2,
			drinks: 0,
			"apps-snacks": 0,
		}).map((s) => s.category.id);

		expect(order[0]).toBe("sides");
		expect(order.at(-1)).toBe("desserts");
	});
});

describe("parsePotluckAnswer", () => {
	it("parses a category and dish", () => {
		expect(parsePotluckAnswer('{"category":"sides","dish":" stuffing "}')).toEqual({
			category: "sides",
			dish: "stuffing",
		});
	});

	it("rejects free text and empty dishes", () => {
		expect(parsePotluckAnswer("pie")).toBeNull();
		expect(parsePotluckAnswer('{"category":"sides","dish":"  "}')).toBeNull();
	});
});
