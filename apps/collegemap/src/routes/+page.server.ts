import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { users, colleges, settings } from '$lib/server/db/schema';
import { eq, isNotNull } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals }) => {
	// Get all users with their colleges
	const rawUsers = await db
		.select({
			id: users.id,
			firstName: users.firstName,
			lastName: users.lastName,
			createdAt: users.createdAt,
			college: {
				id: colleges.id,
				name: colleges.name,
				latitude: colleges.latitude,
				longitude: colleges.longitude
			}
		})
		.from(users)
		.innerJoin(colleges, eq(users.collegeId, colleges.id))
		.where(isNotNull(users.collegeId));

	const usersWithColleges = rawUsers.map((u) => ({
		...u,
		createdAt: u.createdAt.toISOString()
	}));

	// Build college rankings (sorted by student count descending)
	const collegeCountMap = new Map<string, { name: string; count: number }>();
	for (const u of usersWithColleges) {
		const existing = collegeCountMap.get(u.college.id);
		if (existing) {
			existing.count++;
		} else {
			collegeCountMap.set(u.college.id, { name: u.college.name, count: 1 });
		}
	}
	const collegeRankings = Array.from(collegeCountMap.values())
		.sort((a, b) => b.count - a.count);

	// Get settings (or use defaults)
	let appSettings = await db.select().from(settings).where(eq(settings.id, 1)).get();

	if (!appSettings) {
		[appSettings] = await db
			.insert(settings)
			.values({ id: 1, authMode: 'open', mapName: 'College Map' })
			.returning();
	}

	return {
		users: usersWithColleges,
		collegeRankings,
		mapName: appSettings.mapName,
		user: locals.user
			? {
					id: locals.user.id,
					firstName: locals.user.firstName,
					lastName: locals.user.lastName,
					hasCollege: !!locals.user.collegeId
				}
			: null
	};
};
