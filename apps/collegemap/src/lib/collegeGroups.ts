/** A user as the map surfaces them: identity plus the college they pinned themselves to. */
export interface UserWithCollege {
	id: string;
	firstName: string;
	lastName: string;
	createdAt: string;
	college: {
		id: string;
		name: string;
		latitude: number;
		longitude: number;
	};
}

/** One map pin: a college and everyone who picked it. */
export interface CollegeGroup {
	college: UserWithCollege["college"];
	users: { firstName: string; lastName: string }[];
}

/**
 * Collapse a user list into one entry per college, preserving first-seen order.
 *
 * Lives outside the components so the grouping is a plain function over plain data — a component
 * would have to reach for `SvelteMap` for an accumulator that never outlives the call.
 */
export function groupUsersByCollege(sourceUsers: UserWithCollege[]): CollegeGroup[] {
	const groups = new Map<string, CollegeGroup>();

	for (const user of sourceUsers) {
		const existing = groups.get(user.college.id);
		if (existing) {
			existing.users.push({ firstName: user.firstName, lastName: user.lastName });
		} else {
			groups.set(user.college.id, {
				college: user.college,
				users: [{ firstName: user.firstName, lastName: user.lastName }],
			});
		}
	}

	return Array.from(groups.values());
}
