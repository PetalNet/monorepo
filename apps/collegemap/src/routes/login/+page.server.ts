import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { findUserByName, verifyPassword, createSession } from '$lib/server/auth';

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

		if (!password) {
			return fail(400, {
				error: 'Password is required',
				firstName,
				lastName
			});
		}

		// Find user
		const user = await findUserByName(firstName, lastName);
		if (!user) {
			return fail(400, {
				error: 'Invalid name or password',
				firstName,
				lastName
			});
		}

		// Verify password
		const valid = await verifyPassword(password, user.passwordHash);
		if (!valid) {
			return fail(400, {
				error: 'Invalid name or password',
				firstName,
				lastName
			});
		}

		// Create session
		await createSession(cookies, user.id);

		throw redirect(302, '/');
	}
};
