import { env } from "$env/dynamic/private";
import { AuthentikClient } from "$lib/server/authentik";
import { reconciliationFindings, sortFindings } from "$lib/server/findings";
import { evidenceAgeMs, getReconciliation, isStale } from "$lib/server/reconcile";
import { loadLabState, whoReaches } from "$lib/server/state";
import { error } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

/** Module scope: it captures nothing, so rebuilding it per request bought nothing. */
const now = () => Date.now();

function requireEnv(name: string): string {
	const value = env[name];
	if (!value) {
		// A real 500 with a readable cause, rather than an unhandled rejection out of `load`.
		// Refusing to render beats rendering an empty dashboard that looks like a clean bill of
		// health: the whole product is a claim about what is true, so it must not guess.
		error(
			500,
			`${name} is not set. This app reads Authentik over its API and cannot show anything ` +
				"truthful without it.",
		);
	}
	return value;
}

export const load: PageServerLoad = async ({ url }) => {
	const client = new AuthentikClient({
		baseUrl: requireEnv("AUTHENTIK_URL"),
		token: requireEnv("AUTHENTIK_TOKEN"),
	});

	const { state, reconciliation } = await getReconciliation(
		client,
		() => loadLabState(client, new Date().toISOString()),
		now,
		url.searchParams.has("refresh"),
	);

	const reachesCount = new Map<string, number>();
	for (const row of reconciliation.evidence) {
		if (row.evaluated === "allow") {
			reachesCount.set(row.personId, (reachesCount.get(row.personId) ?? 0) + 1);
		}
	}

	// The three-state comparison is the point of the product, so its disagreements belong in the
	// findings list next to the unbound-application ones rather than buried on a single row.
	const findings = sortFindings([
		...state.findings,
		...reconciliationFindings(
			reconciliation.evidence.map((row) => ({
				personId: row.personId,
				resourceId: row.resourceId,
				intended: row.intended,
				configured: row.configured,
				evaluated: row.evaluated,
			})),
		),
	]);

	return {
		state: {
			...state,
			findings,
			people: state.people.map((person) => ({
				...person,
				reaches: reachesCount.get(person.id) ?? 0,
			})),
			resources: state.resources.map((resource) => ({
				...resource,
				reachedBy: whoReaches(state, resource.slug).map((person) => person.username),
			})),
		},
		explain: reconciliation.evidence.map((row) => ({
			personId: row.personId,
			resourceId: row.resourceId,
			decision: row.intended,
			tree: row.tree,
			intended: row.intended,
			configured: row.configured,
			evaluated: row.evaluated,
			disagreement: row.disagreement,
		})),
		evidence: {
			finishedAt: reconciliation.finishedAt,
			ageSeconds: Math.round(evidenceAgeMs(reconciliation, now()) / 1000),
			stale: isStale(reconciliation, now()),
			durationMs: reconciliation.durationMs,
			checks: reconciliation.evidence.length,
			unknownCount: reconciliation.unknownCount,
		},
	};
};
