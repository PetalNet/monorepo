import { Effect } from "effect";

import { relicsApi } from "#lib/server/api.ts";
import { RelicsStore, attempt, requireAdmin } from "#lib/server/services.ts";

import type { PageServerLoad } from "./$types";
export const load: PageServerLoad = (event) =>
	relicsApi.runRaw(
		Effect.gen(function* () {
			const store = yield* RelicsStore;

			return yield* attempt(() => {
				const admin = requireAdmin(store, event);

				return {
					catalog: store.adminData(),
					collection: { sets: store.collection().sets },
					subject: admin.subject,
				};
			});
		}),
		event,
	);
