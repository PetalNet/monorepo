import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clearSession } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { users, colleges } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { emit } from '$lib/server/events';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	// Get current college if set
	let currentCollege = null;
	if (locals.user.collegeId) {
		currentCollege = await db
			.select()
			.from(colleges)
			.where(eq(colleges.id, locals.user.collegeId))
			.get();
	}

	return {
		user: {
			firstName: locals.user.firstName,
			lastName: locals.user.lastName
		},
		currentCollege
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, '/login');
		}

		const data = await request.formData();
		const collegeName = data.get('collegeName')?.toString();
		const latitude = parseFloat(data.get('latitude')?.toString() ?? '');
		const longitude = parseFloat(data.get('longitude')?.toString() ?? '');
		const isCustom = data.get('isCustom')?.toString() === 'true';

		if (!collegeName || isNaN(latitude) || isNaN(longitude)) {
			return fail(400, { error: 'Please select a college' });
		}

		// Check if college already exists
		let college = await db
			.select()
			.from(colleges)
			.where(eq(colleges.name, collegeName))
			.get();

		// Create college if it doesn't exist
		if (!college) {
			[college] = await db
				.insert(colleges)
				.values({
					name: collegeName,
					latitude,
					longitude,
					isCustom
				})
				.returning();
		}

		// Update user's college
		await db
			.update(users)
			.set({ collegeId: college.id })
			.where(eq(users.id, locals.user.id));

		// Fetch user's createdAt for the SSE event
		const updatedUser = await db
			.select({ createdAt: users.createdAt })
			.from(users)
			.where(eq(users.id, locals.user.id))
			.get();

		emit('user-added', {
			id: locals.user.id,
			firstName: locals.user.firstName,
			lastName: locals.user.lastName,
			createdAt: updatedUser?.createdAt?.toISOString() ?? new Date().toISOString(),
			college: {
				id: college.id,
				name: college.name,
				latitude: college.latitude,
				longitude: college.longitude
			}
		});

		return { success: true };
	},

	logout: async ({ cookies }) => {
		clearSession(cookies);
		throw redirect(302, '/');
	}
};
