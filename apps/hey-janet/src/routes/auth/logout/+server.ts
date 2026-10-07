import { redirect } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";
export const POST: RequestHandler = ({ cookies }) => {
	cookies.delete("booth-auth", { path: "/" });
	cookies.delete("booth-participant", { path: "/" });
	redirect(303, "/");
};
