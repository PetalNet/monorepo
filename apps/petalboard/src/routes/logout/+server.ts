import { redirect } from "@sveltejs/kit";

import { deleteSession } from "#lib/server/auth.ts";

export const POST = async ({ cookies }) => {
	await deleteSession(cookies);

	throw redirect(303, "/");
};
