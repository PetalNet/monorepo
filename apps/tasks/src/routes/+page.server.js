import { redirect } from "@sveltejs/kit";

// The gallery is the whole app now.
export function load() {
	throw redirect(307, "/gallery");
}
