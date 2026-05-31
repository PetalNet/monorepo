import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createUser, findUserByName, createSession } from '$lib/server/auth';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) {
		throw redirect(302, '/');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const firstName = data.get('firstName')?.toString().trim();
		const lastName = data.get('lastName')?.toString().trim();
		const password = data.get('password')?.toString();

		if (!firstName || !lastName) {
			return fail(400, {
				error: 'First name and last name are required',
				firstName,
				lastName
			});
		}

		if (!password || password.length < 4 || password.length > 8) {
			return fail(400, {
				error: 'Password must be 4-8 characters',
				firstName,
				lastName
			});
		}

		// Check if user already exists
		const existing = await findUserByName(firstName, lastName);
		if (existing) {
			return fail(400, {
				error: 'An account with this name already exists',
				firstName,
				lastName
			});
		}

		// Create user
		const user = await createUser(firstName, lastName, password);

		// Create session
		await createSession(cookies, user.id);

		throw redirect(302, '/profile');
	}
};
