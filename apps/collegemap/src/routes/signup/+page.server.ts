import { createUser, findUserByName, createSession } from "$lib/server/auth";
import { formText } from "$lib/server/form";
import { fail, redirect } from "@sveltejs/kit";

import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) {
		redirect(302, "/");
	}
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const data = await request.formData();
		const firstName = formText(data, "firstName")?.trim();
		const lastName = formText(data, "lastName")?.trim();
		const password = formText(data, "password");

		if (!firstName || !lastName) {
			return fail(400, {
				error: "First name and last name are required",
				firstName,
				lastName,
			});
		}

		if (!password || password.length < 4 || password.length > 8) {
			return fail(400, {
				error: "Password must be 4-8 characters",
				firstName,
				lastName,
			});
		}

		// Check if user already exists
		const existing = await findUserByName(firstName, lastName);
		if (existing) {
			return fail(400, {
				error: "An account with this name already exists",
				firstName,
				lastName,
			});
		}

		// Create user
		const user = await createUser(firstName, lastName, password);

		// Create session
		await createSession(cookies, user.id);

		redirect(302, "/profile");
	},
};
