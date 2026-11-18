import { todaysDoor } from "$lib/server/door";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals: { store } }) => todaysDoor(store, new Date());
