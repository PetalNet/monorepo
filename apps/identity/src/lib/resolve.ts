/**
 * Access resolution and explanation.
 *
 * Everything the product claims rests on this file, so it is deliberately pure: no database, no
 * network, no clock. Feed it a role graph and it tells you whether a subject reaches a resource
 * and, more importantly, *why*. If this is wrong then every green tick in the UI is a lie, which
 * is the specific failure the product exists to prevent.
 *
 * Resolution order, highest priority first:
 *
 *   1. explicit direct deny    - a deny on a role the subject holds directly
 *   2. inherited deny          - a deny on a role reached through inheritance
 *   3. direct allow            - a grant on a role the subject holds directly
 *   4. inherited allow         - a grant on a role reached through inheritance
 *   5. default deny            - nothing said anything, so no
 *
 * Deny beating allow at every distance is what makes "Friends inherits Media, but Friends must
 * never see Accounting" expressible. Without it you end up cloning roles to carve out exceptions,
 * which is exactly how the lab ended up with four groups holding identical members.
 */

export interface Role {
	id: string;
	name: string;
	/** Roles this role inherits. Admin inheriting Friends means Admin gets everything Friends gets. */
	inherits: string[];
}

export interface Grant {
	roleId: string;
	resourceId: string;
}

export interface Deny {
	roleId: string;
	resourceId: string;
}

export interface RoleGraph {
	roles: Map<string, Role>;
	grants: Grant[];
	denies: Deny[];
}

export type Decision = "allow" | "deny";

/** Why the decision came out the way it did. Ordered most specific to least. */
export type Reason =
	| "explicit-direct-deny"
	| "inherited-deny"
	| "direct-allow"
	| "inherited-allow"
	| "default-deny";

export interface ExplanationStep {
	roleId: string;
	/** How the subject reached this role: 0 = held directly, 1 = one inheritance hop, and so on. */
	distance: number;
	/** The chain from the directly-held role to this one, inclusive of both ends. */
	path: string[];
}

export interface Explanation {
	decision: Decision;
	reason: Reason;
	/** The step that decided it. Null only when nothing matched and the default applied. */
	deciding: ExplanationStep | null;
	/** Every role the subject reaches, in breadth-first order. The "what do I even have" list. */
	reachable: ExplanationStep[];
	/** Steps that would have allowed, but were overridden by a deny. Populated only on a deny. */
	overruled: ExplanationStep[];
}

export type { RoleCycleError };

class RoleCycleError extends Error {
	constructor(readonly cycle: string[]) {
		super(`Role inheritance cycle: ${cycle.join(" -> ")}`);
		this.name = "RoleCycleError";
	}
}

/**
 * Walk the inheritance graph breadth-first from the roles a subject holds directly.
 *
 * Breadth-first matters rather than being an implementation detail: it guarantees the first time
 * a role is reached is by its shortest path, so `distance` is the true distance and the "direct
 * beats inherited" tiers below are meaningful. A role reachable both directly and through a
 * long chain must count as direct.
 *
 * Throws on a cycle instead of silently truncating. A cycle means somebody built a role graph
 * that cannot be reasoned about, and quietly returning a partial answer would hide it forever.
 */
function reachableRoles(graph: RoleGraph, directRoleIds: string[]): ExplanationStep[] {
	const seen = new Map<string, ExplanationStep>();
	const queue: ExplanationStep[] = [];

	for (const roleId of directRoleIds) {
		if (!graph.roles.has(roleId) || seen.has(roleId)) continue;
		const step = { roleId, distance: 0, path: [roleId] };
		seen.set(roleId, step);
		queue.push(step);
	}

	// Cycle detection is a separate depth-first pass, because breadth-first with a `seen` set
	// cannot tell a cycle apart from a diamond: both revisit a node. A diamond is legal.
	detectCycles(graph);

	for (let i = 0; i < queue.length; i++) {
		const current = queue[i]!;
		const role = graph.roles.get(current.roleId);
		if (!role) continue;
		for (const parentId of role.inherits) {
			if (!graph.roles.has(parentId) || seen.has(parentId)) continue;
			const step = {
				roleId: parentId,
				distance: current.distance + 1,
				path: [...current.path, parentId],
			};
			seen.set(parentId, step);
			queue.push(step);
		}
	}

	return queue;
}

/** Depth-first cycle check over the whole graph, so a cycle is caught even in an unused branch. */
function detectCycles(graph: RoleGraph): void {
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];

	const visit = (roleId: string): void => {
		const current = state.get(roleId);
		if (current === "done") return;
		if (current === "visiting") {
			const from = stack.indexOf(roleId);
			throw new RoleCycleError([...stack.slice(from), roleId]);
		}
		state.set(roleId, "visiting");
		stack.push(roleId);
		for (const parentId of graph.roles.get(roleId)?.inherits ?? []) {
			if (graph.roles.has(parentId)) visit(parentId);
		}
		stack.pop();
		state.set(roleId, "done");
	};

	for (const roleId of graph.roles.keys()) visit(roleId);
}

/**
 * Decide whether a subject holding `directRoleIds` reaches `resourceId`, and explain it.
 *
 * The explanation is not decoration. A bare allow/deny is unauditable, and the whole premise of
 * the product is that no permission answer should require a human to trace groups by hand.
 */
export function explainAccess(
	graph: RoleGraph,
	directRoleIds: string[],
	resourceId: string,
): Explanation {
	const reachable = reachableRoles(graph, directRoleIds);
	const byRole = new Map(reachable.map((step) => [step.roleId, step]));

	const denials = graph.denies
		.filter((deny) => deny.resourceId === resourceId && byRole.has(deny.roleId))
		.map((deny) => byRole.get(deny.roleId)!)
		.toSorted(byDistance);

	const allows = graph.grants
		.filter((grant) => grant.resourceId === resourceId && byRole.has(grant.roleId))
		.map((grant) => byRole.get(grant.roleId)!)
		.toSorted(byDistance);

	if (denials.length > 0) {
		const deciding = denials[0]!;
		return {
			decision: "deny",
			reason: deciding.distance === 0 ? "explicit-direct-deny" : "inherited-deny",
			deciding,
			reachable,
			// Surfacing what the deny overrode is the difference between "no" and a usable "no".
			// It is the answer to "but I gave them Friends, why can't they see it".
			overruled: allows,
		};
	}

	if (allows.length > 0) {
		const deciding = allows[0]!;
		return {
			decision: "allow",
			reason: deciding.distance === 0 ? "direct-allow" : "inherited-allow",
			deciding,
			reachable,
			overruled: [],
		};
	}

	return { decision: "deny", reason: "default-deny", deciding: null, reachable, overruled: [] };
}

/**
 * Closest role wins, and ties break on the role id so the answer is deterministic.
 *
 * Determinism is worth spending a comparison on: an explanation that names a different role each
 * time it is asked would destroy trust in every other number the product shows.
 */
function byDistance(a: ExplanationStep, b: ExplanationStep): number {
	return a.distance - b.distance || a.roleId.localeCompare(b.roleId);
}

/** Render an explanation as the indented tree the spec asks for. */
export function renderExplanation(explanation: Explanation, subjectLabel: string): string {
	const lines = [subjectLabel];
	const shown = explanation.deciding ? [explanation.deciding] : explanation.reachable;

	for (const step of shown) {
		step.path.forEach((roleId, depth) => {
			const indent = "  ".repeat(depth + 1);
			const arrow = depth === 0 ? "holds" : "inherits";
			lines.push(`${indent}${arrow} ${roleId}`);
		});
	}

	if (explanation.decision === "allow" && explanation.deciding) {
		const indent = "  ".repeat(explanation.deciding.path.length + 1);
		lines.push(`${indent}grants access`);
	}

	lines.push(`RESULT: ${explanation.decision.toUpperCase()} (${explanation.reason})`);
	return lines.join("\n");
}
