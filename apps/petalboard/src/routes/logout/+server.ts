import { deleteSession } from "$lib/server/auth";
import { redirect } from "@sveltejs/kit";

export const POST = async ({ cookies }) => {
	await deleteSession(cookies);
	throw redirect(303, "/");
};
