import { error, fail } from "@sveltejs/kit";

import { env } from "$env/dynamic/private";

import { AuthentikClient } from "$lib/server/authentik";
import { AuthentikWriter } from "$lib/server/authentik-write";
import { applyAndVerify, impactLevel, simulate } from "$lib/server/changes";
import { getReconciliation, invalidateReconciliation } from "$lib/server/reconcile";
import { loadLabState } from "$lib/server/state";

import type { Actions, PageServerLoad } from "./$types";

const now = () => Date.now();

function config(): { url: string; token: string } {
	const url = env.AUTHENTIK_URL;
	const token = env.AUTHENTIK_TOKEN;
	if (!url || !token) {
		error(500, "AUTHENTIK_URL and AUTHENTIK_TOKEN must both be set.");
	}
	return { url, token };
}

/** The roles this tool can hand out, in the order they should be offered. */
const ASSIGNABLE = ["media", "friends", "admin", "owner", "glovebox-admins", "assist-users"];

export const load: PageServerLoad = async ({ params }) => {
	const { url, token } = config();
	const client = new AuthentikClient({ baseUrl: url, token });
	const { state } = await getReconciliation(
		client,
		() => loadLabState(client, new Date().toISOString()),
		now,
	);

	const person = state.people.find((p) => p.id === params.username);
	if (!person) error(404, `No person called ${params.username}`);

	// Every togglable role carries its own precomputed impact, so tapping one shows consequences
	// immediately instead of asking the server what would happen after the user already decided.
	const roles = ASSIGNABLE.filter((roleId) => state.roleGraph.roles.has(roleId)).map((roleId) => {
		const held = person.roleIds.includes(roleId);
		const impact = simulate(state, {
			kind: held ? "remove-role" : "add-role",
			personId: person.id,
			roleId,
		});
		return {
			roleId,
			name: state.roleGraph.roles.get(roleId)?.name ?? roleId,
			held,
			impact,
			level: impactLevel(impact),
		};
	});

	return {
		person: {
			id: person.id,
			username: person.username,
			displayName: person.displayName,
			email: person.email,
			roleIds: person.roleIds,
			unmappedGroups: person.unmappedGroups,
		},
		roles,
	};
};

export const actions: Actions = {
	/**
	 * Toggle a role, then prove it took.
	 *
	 * A dangerous change requires the person's username typed back. Not theatre: the failure mode
	 * for a mistaken tap on a phone is silent and immediate, and the confirmation is the only
	 * thing standing between a fat finger and someone getting the finances.
	 */
	toggleRole: async ({ params, request }) => {
		const { url, token } = config();
		const form = await request.formData();
		// form.get returns File | string | null, so a posted file would stringify to
		// "[object Object]" and be treated as a role name. Take strings only.
		const text = (key: string): string => {
			const value = form.get(key);
			return typeof value === "string" ? value : "";
		};
		const roleId = text("roleId");
		const held = text("held") === "true";
		const confirmation = text("confirm").trim();

		const client = new AuthentikClient({ baseUrl: url, token });
		const state = await loadLabState(client, new Date().toISOString());
		if (state.error) return fail(502, { message: state.error });

		const person = state.people.find((p) => p.id === params.username);
		if (!person) return fail(404, { message: `No person called ${params.username}` });

		const change = {
			kind: held ? ("remove-role" as const) : ("add-role" as const),
			personId: person.id,
			roleId,
		};
		const impact = simulate(state, change);

		if (impactLevel(impact) === "dangerous" && confirmation !== person.username) {
			return fail(400, {
				message: `This is a high-impact change. Type ${person.username} to confirm.`,
				needsConfirmation: true,
				roleId,
			});
		}

		// Resolve the Authentik group by the name the role maps to. Looked up rather than cached
		// so a group renamed or deleted underneath us fails loudly instead of writing to a stale id.
		const groups = await client.groups();
		const group = groups.find((g) => g.name === roleId);
		if (!group) {
			return fail(409, {
				message: `Authentik has no group called ${roleId}. Nothing was changed.`,
			});
		}

		const writer = new AuthentikWriter({ baseUrl: url, token });
		const result = await applyAndVerify(client, state, change, () =>
			held
				? writer.removeUserFromGroup(group.pk, person.pk)
				: writer.addUserToGroup(group.pk, person.pk),
		);

		// The cached reconciliation now describes the world before this change.
		invalidateReconciliation();

		if (result.error) return fail(502, { message: result.error, impact: result.impact });

		return {
			applied: result.applied,
			verified: result.verified,
			verifications: result.verifications,
			impact: result.impact,
			roleId,
			action: held ? "removed" : "added",
		};
	},
};
