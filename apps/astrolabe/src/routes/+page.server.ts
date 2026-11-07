import { buildDossier } from "$lib/server/dossier";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => ({ dossier: await buildDossier() });
