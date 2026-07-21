import type { Services } from "../substrate.ts";
import { resolveScopes, type Principal } from "./principal.ts";
import type { BetterAuthSessionIdentity } from "./session-identity.ts";
import { lanesForTier } from "./tier-lanes.ts";

const LANE_ORDER = ["viewer", "editor", "operator", "admin"] as const;

/** Convert either supported Better Auth user shape into the one browser-principal vocabulary. */
export async function resolveBrowserPrincipal(
	services: Services,
	identity: BetterAuthSessionIdentity,
): Promise<Principal | null> {
	if (identity.kind === "app") {
		const id = `human:${identity.userId}`;
		const resolved = await resolveScopes(services.db.app, id, [identity.tier]);
		return {
			kind: "human",
			id,
			tiers: [identity.tier],
			lanes: lanesForTier(identity.tier),
			scopes: resolved.scopes,
			zookie: resolved.zookie,
			authSource: "better-auth",
			authSessionId: identity.sessionId,
		};
	}

	await services.db.admin`
		insert into better_auth_principals (oidc_subject, principal_id)
		values (${identity.subject}, ${identity.username}) on conflict do nothing`;
	const binding = await services.db.admin<{ principal_id: string }[]>`
		select principal_id from better_auth_principals where oidc_subject = ${identity.subject}`;
	if (binding[0]?.principal_id !== identity.username) return null;
	const inheritsAdmin =
		identity.groups.includes("authentik Admins") || identity.groups.includes("admin");
	if (!inheritsAdmin) return null;
	const rows = await services.db.admin<{ name: string; default_relations: string[] }[]>`
		select name, default_relations from tiers where name = 'owner' order by name`;
	if (rows.length === 0) return null;
	const tiers = rows.map((row) => row.name);
	let laneCeiling = -1;
	for (const row of rows) {
		for (const relation of row.default_relations) {
			const lane = relation === "owner" ? "admin" : relation;
			laneCeiling = Math.max(laneCeiling, LANE_ORDER.indexOf(lane as (typeof LANE_ORDER)[number]));
		}
	}
	const lanes: string[] = laneCeiling < 0 ? [] : LANE_ORDER.slice(0, laneCeiling + 1);
	if (identity.groups.includes("term_admin")) lanes.push("term_admin");
	const resolved = await resolveScopes(services.db.admin, identity.username, tiers);
	return {
		kind: "human",
		id: identity.username,
		tiers,
		lanes,
		scopes: resolved.scopes,
		zookie: resolved.zookie,
		authSource: "better-auth",
		authSessionId: identity.sessionId,
	};
}
