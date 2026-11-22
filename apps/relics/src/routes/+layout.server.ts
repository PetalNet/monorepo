import { Effect } from "effect";

import { relicsApi } from "#lib/server/api.ts";
import { RelicsStore, device, attempt } from "#lib/server/services.ts";

import type { LayoutServerLoad } from "./$types";
export const load: LayoutServerLoad = (event) =>
	relicsApi.runRaw(
		Effect.gen(function* () {
			const store = yield* RelicsStore;

			return yield* attempt(() => ({
				firstName: store.collector(device(event))?.name ?? null,
				admin: Boolean(store.admin(event.cookies.get("relics_admin"))),
			}));
		}),
		event,
	);
