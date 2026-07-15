import { auth } from "$lib/server/auth";
import { redeemAdminBootstrap } from "$lib/server/auth/bootstrap";
import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({ authenticated: Boolean(locals.user) });

export const actions: Actions = {
	claim: async ({ locals, request }) => {
		if (!locals.user) redirect(303, "/login");
		const code = String((await request.formData()).get("code") ?? "");
		if (!await redeemAdminBootstrap(auth, locals.user.id, code)) return fail(400, { invalid: true });
		redirect(303, "/");
	},
};
