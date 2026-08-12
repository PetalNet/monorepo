/**
 * The change engine: simulate, apply, verify.
 *
 * A successful API call is not a successful identity change. Authentik can accept a group
 * membership write and still not grant what you expected, because access is the product of a
 * policy graph rather than of one row. So every mutation goes: work out the impact, make the
 * change, read the configuration back, then ask Authentik what it now evaluates for that person.
 * Only when the observed result matches the predicted one does the change get called verified.
 *
 * The prediction is the load-bearing part. Applying and then reporting whatever happened is easy
 * and worthless: without a prediction there is nothing for the verification to disagree with, and
 * a verification that cannot fail is decoration.
 */

import type { AuthentikClient } from "./authentik";
import type { LabState } from "./state";
import { explainAccess } from "../resolve";

export interface RoleChange {
	kind: "add-role" | "remove-role";
	personId: string;
	roleId: string;
}

export interface Impact {
	/** Resources the person does not have now and would have after. */
	gains: string[];
	/** Resources they have now and would keep. */
	keeps: string[];
	/** Resources they have now and would lose. */
	loses: string[];
	/** Resources they do not have and still would not. Named so "no change" is explicit. */
	stillDenied: string[];
	/** What we will assert after applying. Empty means nothing would be proven. */
	postconditions: { resourceId: string; expect: "allow" | "deny" }[];
}

export interface VerificationResult {
	resourceId: string;
	expected: "allow" | "deny";
	observed: "allow" | "deny" | "unknown";
	passed: boolean;
}

export interface ChangeSetResult {
	applied: boolean;
	impact: Impact;
	verifications: VerificationResult[];
	/** True only when every postcondition was checked and every one matched. */
	verified: boolean;
	error: string | null;
}

/**
 * Work out what a role change would do, without touching anything.
 *
 * This is pure: it runs the same resolver the rest of the product uses against a hypothetical
 * role list. Using a different code path for the prediction than for the live answer would be
 * how the two quietly stop agreeing.
 */
export function simulate(state: LabState, change: RoleChange): Impact {
	const person = state.people.find((p) => p.id === change.personId);
	if (!person) {
		return { gains: [], keeps: [], loses: [], stillDenied: [], postconditions: [] };
	}

	const before = person.roleIds;
	const after =
		change.kind === "add-role"
			? [...new Set([...before, change.roleId])]
			: before.filter((role) => role !== change.roleId);

	const gains: string[] = [];
	const keeps: string[] = [];
	const loses: string[] = [];
	const stillDenied: string[] = [];

	for (const resource of state.resources) {
		const had = explainAccess(state.roleGraph, before, resource.slug).decision === "allow";
		const has = explainAccess(state.roleGraph, after, resource.slug).decision === "allow";
		if (!had && has) gains.push(resource.slug);
		else if (had && has) keeps.push(resource.slug);
		else if (had && !has) loses.push(resource.slug);
		else stillDenied.push(resource.slug);
	}

	// Assert on what changed, plus a sample of what must NOT change. Checking only the gains
	// would let a change that accidentally opened something else pass as verified, so the denies
	// are the half that makes this a test rather than a formality.
	//
	// Unbound applications are excluded from the deny sample. An unbound app admits every
	// authenticated account, so intended=deny and evaluated=allow for everyone, always - it is a
	// standing problem with its own critical finding, not something this change caused. Asserting
	// on it would mark every unrelated change "not verified" and teach the operator that the red
	// banner means nothing, which is worse than not checking at all.
	const unbound = new Set(state.resources.filter((r) => r.unbound).map((r) => r.slug));
	const denySample = stillDenied.filter((slug) => !unbound.has(slug)).slice(0, 5);

	const postconditions = [
		...gains.map((resourceId) => ({ resourceId, expect: "allow" as const })),
		...loses.filter((slug) => !unbound.has(slug)).map((resourceId) => ({ resourceId, expect: "deny" as const })),
		...denySample.map((resourceId) => ({ resourceId, expect: "deny" as const })),
	];

	return { gains, keeps, loses, stillDenied, postconditions };
}

/** How dangerous a change is, which decides how much friction the UI puts in front of it. */
export function impactLevel(impact: Impact): "normal" | "significant" | "dangerous" {
	const changed = impact.gains.length + impact.loses.length;
	if (impact.gains.some((slug) => DANGEROUS_RESOURCES.has(slug))) return "dangerous";
	if (changed >= 8) return "dangerous";
	if (changed >= 3) return "significant";
	return "normal";
}

/**
 * Resources where a wrong grant is not merely inconvenient.
 *
 * Deliberately a small hand-maintained list rather than something inferred: guessing which
 * applications hold sensitive data from their names is exactly the kind of cleverness that is
 * wrong once and then trusted forever.
 */
const DANGEROUS_RESOURCES = new Set([
	"accounting",
	"actual",
	"actual-oidc",
	"dawarich",
	"daybook",
	"firefly",
	"garmin",
	"immich-tools",
	"ldap",
	"paperless",
	"petalnet-admin",
	"vaultwarden",
]);

/**
 * Apply a role change, then prove it.
 *
 * `mutate` is injected so the caller owns the write. Keeping the only mutating call outside this
 * module means the simulation path cannot accidentally acquire the ability to change anything.
 */
export async function applyAndVerify(
	client: AuthentikClient,
	state: LabState,
	change: RoleChange,
	mutate: () => Promise<void>,
): Promise<ChangeSetResult> {
	const impact = simulate(state, change);
	const person = state.people.find((p) => p.id === change.personId);
	if (!person) {
		return {
			applied: false,
			impact,
			verifications: [],
			verified: false,
			error: `No such person: ${change.personId}`,
		};
	}

	try {
		await mutate();
	} catch (cause) {
		return {
			applied: false,
			impact,
			verifications: [],
			verified: false,
			error: `Authentik rejected the change: ${String(cause)}`,
		};
	}

	// Postconditions are independent of each other, so they verify in parallel. Unlike the full
	// reconciliation sweep this is a handful of calls for one person, not several hundred, so
	// there is nothing to throttle and the operator waits once rather than once per assertion.
	const verifications: VerificationResult[] = await Promise.all(
		impact.postconditions.map(async (postcondition) => {
			let observed: VerificationResult["observed"];
			try {
				observed = (await client.checkAccess(postcondition.resourceId, person.pk))
					? "allow"
					: "deny";
			} catch {
				observed = "unknown";
			}
			return {
				resourceId: postcondition.resourceId,
				expected: postcondition.expect,
				observed,
				// An unknown is not a pass. The change may well be fine, but we did not prove it,
				// and "could not check" must never render the same as "checked and it was right".
				passed: observed === postcondition.expect,
			};
		}),
	);

	return {
		applied: true,
		impact,
		verifications,
		// A change with nothing to assert is not verified, it is merely applied. Saying otherwise
		// would put a tick next to a claim nobody tested.
		verified: verifications.length > 0 && verifications.every((v) => v.passed),
		error: null,
	};
}
