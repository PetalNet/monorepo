import { z } from "zod";

export const potluckCategorySchema = z.object({
	id: z.string().trim().min(1).max(40),
	label: z.string().trim().min(1, "Category name is required").max(40),
	ratio: z.number().positive("Each category needs a share above 0").max(100),
	ideas: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
	forceOpen: z.boolean().default(false),
});

export const potluckConfigSchema = z.object({
	providing: z.string().trim().max(200).default(""),
	minOptions: z.number().int().min(1).max(12).default(2),
	categories: z
		.array(potluckCategorySchema)
		.min(2, "Add at least two categories")
		.max(12)
		.refine((cats) => new Set(cats.map((c) => c.id)).size === cats.length, {
			message: "Category names must be unique",
		}),
});

export const potluckAnswerSchema = z.object({
	category: z.string().min(1),
	dish: z.string().trim().min(1, "Tell people what you're bringing").max(80),
});

export type PotluckCategory = z.infer<typeof potluckCategorySchema>;
export type PotluckConfig = z.infer<typeof potluckConfigSchema>;
export type PotluckAnswer = z.infer<typeof potluckAnswerSchema>;
export type CategoryCounts = Readonly<Record<string, number>>;
export interface PotluckView {
	config: PotluckConfig;
	counts: Record<string, number>;
	taken: { category: string; dish: string; name: string | null }[];
}

const ideas = (list: string) => list.split(", ");

export const FRIENDSGIVING_POTLUCK: PotluckConfig = {
	providing: "Pulled chicken and pork, mac and cheese, and green beans",
	// With four categories, three always-offered would leave only one that can close.
	minOptions: 2,
	categories: [
		{
			id: "sides",
			label: "Sides",
			ratio: 50,
			ideas: ideas(
				"mashed potatoes, hash-brown casserole, stuffing, buttered corn, sweet potato casserole, rolls, salad, roasted veggies, cranberry sauce",
			),
			forceOpen: false,
		},
		{
			id: "apps-snacks",
			label: "Apps & snacks",
			ratio: 20,
			ideas: ideas(
				"buffalo chicken dip, chips and dip, fruit tray, veggie tray, charcuterie board, deviled eggs, spinach artichoke dip, pigs in a blanket",
			),
			forceOpen: false,
		},
		{
			id: "desserts",
			label: "Desserts",
			ratio: 20,
			ideas: ideas(
				"pumpkin pie, apple pie, banana pudding, tiramisu, cookies, cheesecake, brownies, chocolate covered strawberries",
			),
			forceOpen: false,
		},
		{
			id: "drinks",
			label: "Drinks",
			ratio: 10,
			ideas: ideas("soda, apple cider, lemonade, sparkling water, iced tea"),
			forceOpen: false,
		},
	],
};

export type OfferReason = "open" | "forced" | "minimum" | "closed";

export interface CategoryStanding {
	category: PotluckCategory;
	count: number;
	share: number;
	cap: number;
	deficit: number;
	reason: OfferReason;
}

/**
 * With n dishes signed up, the next dish makes n + 1, so a category may hold at most ceil(share *
 * (n + 1)) dishes. The ceiling lets every category take its first dish and keeps each within one
 * dish of its share. A full category closes unless the host forced it open, or unless fewer than
 * minOptions would be offered; then the closed categories nearest their target reopen. Sorted
 * most-under-target first.
 */
export function standings(config: PotluckConfig, counts: CategoryCounts): CategoryStanding[] {
	const totalRatio = config.categories.reduce((sum, c) => sum + c.ratio, 0);
	const n = config.categories.reduce((sum, c) => sum + (counts[c.id] ?? 0), 0);

	const ranked = config.categories
		.map((category) => {
			const count = counts[category.id] ?? 0;
			const share = category.ratio / totalRatio;
			const cap = Math.ceil(share * (n + 1) - 1e-9);

			return { category, count, share, cap, deficit: share * (n + 1) - count };
		})
		// toSorted is stable, so ties keep the host's category order.
		.toSorted((a, b) => b.deficit - a.deficit);

	const minimum = Math.min(config.minOptions, config.categories.length);
	let offered = 0;
	const result: CategoryStanding[] = ranked.map((s) => {
		const reason: OfferReason = s.category.forceOpen
			? "forced"
			: s.count < s.cap
				? "open"
				: "closed";

		if (reason !== "closed") {
			offered++;
		}

		return { ...s, reason };
	});

	for (const s of result) {
		if (offered >= minimum) {
			break;
		}

		if (s.reason === "closed") {
			s.reason = "minimum";
			offered++;
		}
	}

	return result;
}

export function offeredCategoryIds(config: PotluckConfig, counts: CategoryCounts): string[] {
	return standings(config, counts)
		.filter((s) => s.reason !== "closed")
		.map((s) => s.category.id);
}

export type SlotStatus = "needed-most" | "open" | "full";

/** The public "Needed most / Full for now" list, most-needed first. */
export function slotStatuses(
	config: PotluckConfig,
	counts: CategoryCounts,
): { category: PotluckCategory; count: number; status: SlotStatus }[] {
	const ranked = standings(config, counts);
	const neededMost = ranked.find((s) => s.reason !== "closed" && s.deficit >= 1);

	return ranked.map((s) => ({
		category: s.category,
		count: s.count,
		status: s.reason === "closed" ? "full" : s === neededMost ? "needed-most" : "open",
	}));
}

export function parsePotluckAnswer(raw: string | null | undefined): PotluckAnswer | null {
	if (!raw) {
		return null;
	}

	try {
		const parsed = potluckAnswerSchema.safeParse(JSON.parse(raw));

		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function parsePotluckConfig(raw: string): PotluckConfig {
	return potluckConfigSchema.parse(JSON.parse(raw));
}

/** Ideas nobody has claimed yet, matched case-insensitively against dish names. */
export function unclaimedIdeas(
	category: PotluckCategory,
	takenDishes: readonly string[],
): string[] {
	const taken = new Set(takenDishes.map((d) => d.trim().toLowerCase()));

	return category.ideas.filter((idea) => !taken.has(idea.toLowerCase()));
}

export function countByCategory(answers: Iterable<PotluckAnswer>): Record<string, number> {
	const counts: Record<string, number> = {};

	for (const a of answers) {
		counts[a.category] = (counts[a.category] ?? 0) + 1;
	}

	return counts;
}

export function slugifyCategory(label: string): string {
	return (
		label
			.toLowerCase()
			.replaceAll("&", " ")
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replaceAll(/^-+|-+$/g, "")
			.slice(0, 40) || "category"
	);
}
