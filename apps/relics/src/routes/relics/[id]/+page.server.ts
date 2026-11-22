import { Effect } from "effect";

import { relicsApi } from "#lib/server/api.ts";
import { RelicsStore, attempt, device } from "#lib/server/services.ts";

import type { PageServerLoad } from "./$types";
export const load: PageServerLoad = (event) =>
	relicsApi.runRaw(
		Effect.gen(function* () {
			const store = yield* RelicsStore;

			return yield* attempt(() => ({ relic: store.card(event.params.id, device(event)) }));
		}),
		event,
	);
