import { MODE_COOKIE, parseMode } from "#lib/mode.ts";

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ cookies }) => ({
	mode: parseMode(cookies.get(MODE_COOKIE)),
});
