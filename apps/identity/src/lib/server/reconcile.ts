/**
 * The reconciliation cycle, and the cache that keeps it off the request path.
 *
 * Evaluating every person against every application is ~800 calls to Authentik. Doing that inside a
 * page load made the page take 36 seconds, and even with a worker pool it was 15. More concurrency
 * was the wrong fix: the real mistake was treating a reconciliation cycle as a rendering step.
 *
 * So it runs on its own, the result is cached with the time it was produced, and the UI shows that
 * age. This is the evidence model the spec asks for rather than a performance trick: a result
 * verified two minutes ago and one verified nineteen days ago are different claims, and the
 * interface has to be able to tell them apart. Rendering a live number every time would actually
 * make that _harder_, because it hides the fact that evidence has an age at all.
 */

import { renderExplanation } from "../resolve";
import type { AuthentikClient } from "./authentik";
import type { LabState } from "./state";
import { explainFor } from "./state";

export interface AccessEvidence {
	personId: string;
	resourceId: string;
	/** What the role graph says should be true. */
	intended: "allow" | "deny";
	/** What Authentik's configuration says. */
	configured: "allow" | "deny";
	/** What Authentik answers when asked about this specific person. Unknown is not a denial. */
	evaluated: "allow" | "deny" | "unknown";
	tree: string;
	disagreement: string | null;
}

export interface Reconciliation {
	evidence: AccessEvidence[];
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	/** Calls that failed. Surfaced, never folded into the deny count. */
	unknownCount: number;
}

/** How long a reconciliation is considered current. Beyond this the UI should say so. */
const EVIDENCE_TTL_MS = 5 * 60 * 1000;

const CONCURRENCY = 12;

/**
 * Run one full cycle: for every person and every application, compare intended, configured and
 * evaluated.
 *
 * `now` is injected rather than read from the clock so this is testable and so two rows in the same
 * cycle cannot disagree about when the cycle happened.
 */
async function reconcile(
	client: AuthentikClient,
	state: LabState,
	now: () => number,
): Promise<Reconciliation> {
	const started = now();
	const jobs = state.people.flatMap((person) =>
		state.resources.map((resource) => ({ person, resource })),
	);
	const evidence: AccessEvidence[] = [];
	let cursor = 0;

	/**
	 * One job, then the next. Recursive rather than a loop so that the sequential await is the shape
	 * of the function instead of something hidden inside one: a worker takes the next job only after
	 * finishing the current one, and that is precisely what bounds the concurrency.
	 */
	async function worker(): Promise<void> {
		const index = cursor++;
		if (index >= jobs.length) return;

		const { person, resource } = jobs[index];
		const explanation = explainFor(state, person.id, resource.slug);
		if (explanation) {
			let evaluated: AccessEvidence["evaluated"];
			try {
				evaluated = (await client.checkAccess(resource.slug, person.pk)) ? "allow" : "deny";
			} catch {
				// A failed check is missing information, not a denial. Counting it as deny would
				// manufacture "broken access" findings out of network errors.
				evaluated = "unknown";
			}

			const intended = explanation.decision;
			evidence.push({
				personId: person.id,
				resourceId: resource.slug,
				intended,
				configured: resource.unbound ? "allow" : intended,
				evaluated,
				tree: renderExplanation(explanation, person.username),
				disagreement:
					evaluated === "unknown"
						? "Authentik could not be asked about this pair, so the live answer is unknown."
						: evaluated !== intended
							? `Intended ${intended}, Authentik evaluates ${evaluated}.`
							: null,
			});
		}

		return worker();
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	const finished = now();

	return {
		evidence,
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(finished).toISOString(),
		durationMs: finished - started,
		unknownCount: evidence.filter((row) => row.evaluated === "unknown").length,
	};
}

/**
 * Process-wide cache of the last cycle.
 *
 * Deliberately in memory: this is derived state that can always be rebuilt from Authentik, so
 * persisting it would create a second thing that can be stale in a way nobody notices. Losing it on
 * restart costs one slow page and nothing else.
 */
let cached: { state: LabState; reconciliation: Reconciliation } | null = null;
let inFlight: Promise<{ state: LabState; reconciliation: Reconciliation }> | null = null;

/**
 * Drop the cache after a mutation.
 *
 * Without this the page would keep serving the pre-change picture and quietly contradict the
 * verification that just ran, which is the exact "configured says one thing, screen says another"
 * confusion the product exists to remove.
 */
export function invalidateReconciliation(): void {
	cached = null;
}

export function evidenceAgeMs(reconciliation: Reconciliation, now: number): number {
	return now - Date.parse(reconciliation.finishedAt);
}

export function isStale(reconciliation: Reconciliation, now: number): boolean {
	return evidenceAgeMs(reconciliation, now) > EVIDENCE_TTL_MS;
}

/**
 * Return the current reconciliation, refreshing if it has aged out.
 *
 * Concurrent callers share one in-flight run. Without that, three tabs opening at once would each
 * start their own ~800-call sweep against the service that authenticates the lab.
 */
export async function getReconciliation(
	client: AuthentikClient,
	loadState: () => Promise<LabState>,
	now: () => number,
	force = false,
): Promise<{ state: LabState; reconciliation: Reconciliation }> {
	if (!force && cached && !isStale(cached.reconciliation, now())) return cached;
	if (inFlight) return inFlight;

	inFlight = (async () => {
		try {
			const state = await loadState();
			const reconciliation = await reconcile(client, state, now);
			cached = { state, reconciliation };
			return cached;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
}
