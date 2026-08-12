/**
 * Builds the reconciled view of the lab from live Authentik data.
 *
 * This is the only place that decides what a "role" is today. Authentik has groups, not roles,
 * and no inheritance, so the role graph is declared here and projected onto what Authentik
 * actually holds. That projection is the honest version of the story: PetalNet owns intent,
 * Authentik owns authentication, and the gap between them is exactly what the product reports.
 */

import {
	AuthentikClient,
	AuthentikError,
	unboundApplications,
	type AuthentikApplication,
	type AuthentikBinding,
	type AuthentikUser,
} from "./authentik";
import {
	onboardingGate,
	peopleOnly,
	sortFindings,
	unboundApplicationFindings,
	type Finding,
	type OnboardingGate,
} from "./findings";
import { explainAccess, type Explanation, type RoleGraph } from "../resolve";

/**
 * The role hierarchy, declared rather than discovered.
 *
 * The lab's Authentik groups grew one application at a time, which is how four of them ended up
 * with identical members. Inheritance is what collapses that: Owner implies Admin implies Friends
 * implies Media, so a person is listed once at the level they belong to. The group names on the
 * right are the Authentik groups each role currently maps to.
 */
const ROLE_GRAPH: RoleGraph = {
	roles: new Map(
		[
			{ id: "owner", name: "Owner", inherits: ["admin"] },
			{ id: "admin", name: "Admin", inherits: ["friends"] },
			{ id: "friends", name: "Friends", inherits: ["media"] },
			{ id: "media", name: "Media", inherits: [] },
			{ id: "glovebox-admins", name: "Glovebox Admin", inherits: [] },
			{ id: "assist-users", name: "Agent Surfaces", inherits: [] },
		].map((role) => [role.id, role]),
	),
	// Populated from Authentik's real bindings at load time. Declaring them by hand would be a
	// second source of truth that silently drifts from the thing actually enforcing access.
	grants: [],
	denies: [],
};

export interface Person {
	id: string;
	pk: number;
	username: string;
	displayName: string;
	email: string;
	roleIds: string[];
	/** Authentik groups they hold that this app has no role for. Visible, not hidden. */
	unmappedGroups: string[];
}

export interface ResourceRow {
	slug: string;
	name: string;
	boundTo: string[];
	unbound: boolean;
}

export interface LabState {
	people: Person[];
	machines: { username: string; type: string }[];
	resources: ResourceRow[];
	roleGraph: RoleGraph;
	findings: Finding[];
	gate: OnboardingGate;
	/** Set when a read failed. Never silently degrades to an empty, healthy-looking view. */
	error: string | null;
	readAt: string;
}

/**
 * Turn an Authentik group name into a role id. Groups this app models as roles keep their name;
 * everything else stays visible as an unmapped group rather than being dropped, because a group
 * nobody models is exactly the sort of thing that later turns out to grant something.
 */
function toRoleIds(groups: { name: string }[]): { roleIds: string[]; unmapped: string[] } {
	const roleIds: string[] = [];
	const unmapped: string[] = [];
	for (const group of groups) {
		if (ROLE_GRAPH.roles.has(group.name)) roleIds.push(group.name);
		else unmapped.push(group.name);
	}
	return { roleIds, unmapped };
}

export async function loadLabState(client: AuthentikClient, readAt: string): Promise<LabState> {
	let users: AuthentikUser[];
	let applications: AuthentikApplication[];
	let bindings: AuthentikBinding[];

	try {
		// Group membership arrives on each user as `groups_obj`, so /core/groups/ is not fetched:
		// it was a round trip to the lab's authentication service whose result nothing read.
		[users, applications, bindings] = await Promise.all([
			client.users(),
			client.applications(),
			client.bindings(),
		]);
	} catch (cause) {
		// Fail loud. An empty dashboard that looks calm is the worst possible output here: it
		// reports "no problems" when what actually happened is "we could not look".
		const message =
			cause instanceof AuthentikError
				? `Could not read Authentik (${cause.status} on ${cause.path}). Nothing below is current.`
				: `Could not read Authentik: ${String(cause)}`;
		return {
			people: [],
			machines: [],
			resources: [],
			roleGraph: ROLE_GRAPH,
			findings: [],
			gate: { blocked: true, reason: message, unboundApplications: [] },
			error: message,
			readAt,
		};
	}

	const bindingsByApp = new Map<string, string[]>();
	for (const binding of bindings) {
		if (!binding.enabled) continue;
		const label = binding.group_obj?.name ?? binding.policy_obj?.name ?? `user:${binding.user}`;
		bindingsByApp.set(binding.target, [...(bindingsByApp.get(binding.target) ?? []), label]);
	}

	const graph: RoleGraph = {
		roles: ROLE_GRAPH.roles,
		// A binding on a group this app models as a role becomes a grant. That keeps the
		// explanation tree describing what Authentik really enforces, not a parallel fiction.
		grants: bindings
			.filter((b) => b.enabled && b.group_obj && ROLE_GRAPH.roles.has(b.group_obj.name))
			.map((b) => ({
				roleId: b.group_obj!.name,
				resourceId: applications.find((a) => a.pk === b.target)?.slug ?? b.target,
			})),
		denies: [],
	};

	const humans = peopleOnly(users);
	const people: Person[] = humans.map((user) => {
		const { roleIds, unmapped } = toRoleIds(user.groups_obj ?? []);
		return {
			id: user.username,
			pk: user.pk,
			username: user.username,
			displayName: user.name || user.username,
			email: user.email,
			roleIds,
			unmappedGroups: unmapped,
		};
	});

	const unbound = unboundApplications(applications, bindings);
	const resources: ResourceRow[] = applications
		.map((app) => ({
			slug: app.slug,
			name: app.name,
			boundTo: bindingsByApp.get(app.pk) ?? [],
			unbound: (bindingsByApp.get(app.pk) ?? []).length === 0,
		}))
		.toSorted((a, b) => Number(b.unbound) - Number(a.unbound) || a.name.localeCompare(b.name));

	return {
		people: people.toSorted((a, b) => a.username.localeCompare(b.username)),
		machines: users
			.filter((u) => u.type !== "internal")
			.map((u) => ({ username: u.username, type: u.type })),
		resources,
		roleGraph: graph,
		findings: sortFindings(unboundApplicationFindings(unbound)),
		gate: onboardingGate(unbound),
		error: null,
		readAt,
	};
}

/** Why a named person can or cannot reach a named resource. */
export function explainFor(state: LabState, personId: string, resourceId: string): Explanation | null {
	const person = state.people.find((p) => p.id === personId);
	if (!person) return null;
	return explainAccess(state.roleGraph, person.roleIds, resourceId);
}

/** Everyone the role graph says reaches a resource. */
export function whoReaches(state: LabState, resourceId: string): Person[] {
	return state.people.filter(
		(person) => explainAccess(state.roleGraph, person.roleIds, resourceId).decision === "allow",
	);
}
