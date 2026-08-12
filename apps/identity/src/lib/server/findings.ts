/**
 * Findings: deterministic rules over the reconciled state.
 *
 * Every finding is a plain boolean over facts that were read, never a heuristic and never a
 * judgement call. A finding a human cannot re-derive by hand is a finding they will learn to
 * ignore, and an ignored warning is worse than no warning because it looks like coverage.
 *
 * Each rule also carries the evidence that produced it, because "what evidence produced this
 * warning" has to have an answer for every single row.
 */

import type { AuthentikApplication, AuthentikUser } from "./authentik";

export type Severity = "critical" | "warning" | "info";

export type FindingKind =
	| "UNBOUND_APPLICATION"
	| "CONFIGURATION_DRIFT"
	| "UNEXPECTED_ACCESS"
	| "BROKEN_ACCESS"
	| "ORPHAN_IDENTITY"
	| "LOCAL_AUTH_BYPASS"
	| "MFA_REQUIRED"
	| "VISIBILITY_LOSS";

export interface Finding {
	kind: FindingKind;
	severity: Severity;
	/** Stable across runs for the same underlying problem, so it can be acknowledged. */
	id: string;
	subject: string;
	explanation: string;
	evidence: string;
}

/** What we intended, what Authentik is configured to do, and what Authentik actually answers. */
export interface AccessRow {
	personId: string;
	resourceId: string;
	intended: "allow" | "deny";
	configured: "allow" | "deny" | "unknown";
	evaluated: "allow" | "deny" | "unknown";
}

/**
 * An application nobody has bound. Critical rather than warning: the failure mode is silent and
 * the blast radius is every account that exists now or later.
 */
export function unboundApplicationFindings(applications: AuthentikApplication[]): Finding[] {
	return applications.map((app) => ({
		kind: "UNBOUND_APPLICATION" as const,
		severity: "critical" as const,
		id: `unbound:${app.slug}`,
		subject: app.name,
		explanation:
			"No policy binding, so every authenticated account can reach it. " +
			"Authentik's default for an unbound application is open, not closed.",
		evidence: `application ${app.slug} has zero enabled policy bindings`,
	}));
}

/**
 * Where the three states disagree.
 *
 * `unknown` never produces a finding here. An unknown is a hole in our visibility, not a
 * statement about access, and reporting it as drift would manufacture alarm out of ignorance.
 * It gets its own VISIBILITY_LOSS finding instead so the gap is still visible.
 */
export function reconciliationFindings(rows: AccessRow[]): Finding[] {
	const findings: Finding[] = [];

	for (const row of rows) {
		const where = `${row.personId} -> ${row.resourceId}`;

		if (row.configured === "unknown" || row.evaluated === "unknown") {
			findings.push({
				kind: "VISIBILITY_LOSS",
				severity: "warning",
				id: `visibility:${where}`,
				subject: where,
				explanation:
					"Could not determine the real state. This is missing information, not a clean result.",
				evidence: `configured=${row.configured} evaluated=${row.evaluated}`,
			});
			continue;
		}

		if (row.intended === "deny" && row.configured === "allow") {
			findings.push({
				kind: "CONFIGURATION_DRIFT",
				severity: "critical",
				id: `drift:${where}`,
				subject: where,
				explanation: "Configured to allow, but the intended state is deny.",
				evidence: `intended=deny configured=allow`,
			});
		}

		if (row.intended === "deny" && row.evaluated === "allow") {
			findings.push({
				kind: "UNEXPECTED_ACCESS",
				severity: "critical",
				id: `unexpected:${where}`,
				subject: where,
				explanation: "Access is live and was never intended.",
				evidence: `intended=deny evaluated=allow`,
			});
		}

		if (row.intended === "allow" && row.evaluated === "deny") {
			findings.push({
				kind: "BROKEN_ACCESS",
				severity: "warning",
				id: `broken:${where}`,
				subject: where,
				explanation: "Someone is supposed to have this and does not. Broken, not dangerous.",
				evidence: `intended=allow evaluated=deny`,
			});
		}
	}

	return findings;
}

/**
 * The onboarding gate.
 *
 * Creating an account while applications are open to every authenticated user hands the new
 * person everything the moment they claim it. The gate exists because that mistake is invisible
 * at the moment it is made and expensive afterwards, and because it is the exact situation the
 * lab is in right now.
 */
export interface OnboardingGate {
	blocked: boolean;
	reason: string;
	unboundApplications: string[];
}

export function onboardingGate(applications: AuthentikApplication[]): OnboardingGate {
	const slugs = applications.map((app) => app.slug).toSorted();
	if (slugs.length === 0) {
		return { blocked: false, reason: "Every application has an access policy.", unboundApplications: [] };
	}
	return {
		blocked: true,
		reason:
			(slugs.length === 1
				? "1 application currently permits every authenticated account."
				: `${String(slugs.length)} applications currently permit every authenticated account.`) +
			" Creating another account could expose data.",
		unboundApplications: slugs,
	};
}

/** Worst first, then stable by id so the list does not reshuffle between runs. */
export function sortFindings(findings: Finding[]): Finding[] {
	const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
	// toSorted rather than a spread plus sort: same result, and it cannot be mistaken for the
	// in-place version by whoever edits it next.
	return findings.toSorted(
		(a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id),
	);
}

/** Machine accounts are exempt from person-shaped rules; they get their own lifecycle. */
export function peopleOnly(users: AuthentikUser[]): AuthentikUser[] {
	return users.filter(
		(user) =>
			user.type === "internal" && user.username !== "AnonymousUser" && user.is_active,
	);
}
