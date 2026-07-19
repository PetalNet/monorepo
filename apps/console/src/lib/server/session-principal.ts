import { resolveScopes, type Principal } from "./domain/auth/principal";
import type { Services } from "./domain/substrate";

const lanes = {
	owner: ["viewer", "editor", "operator", "admin", "term_admin"],
	operator: ["viewer", "editor", "operator"],
	editor: ["viewer", "editor"],
	viewer: ["viewer"],
} as const;

/** Resolve a browser better-auth session cookie into the substrate's principal vocabulary. */
export async function resolveSessionPrincipal(
	services: Services,
	headers: Headers,
): Promise<Principal | null> {
	const cookie = headers.get("cookie") ?? "";
	const stored = cookie
		.split(";")
		.map((part) => part.trim().split("="))
		.find(([name]) => name === "console.session_token" || name === "__Host-console.session_token");
	const token = stored?.slice(1).join("=").split(".")[0];
	if (!token) return null;
	const rows = await services.db.admin<Array<{ user_id: string; tier: string }>>`
	select s."userId" as user_id, u.tier
	from session s join "user" u on u.id = s."userId"
	where s.token = ${decodeURIComponent(token)} and s."expiresAt" > now()`;
	const row = rows.at(0);
	if (!row) return null;
	if (!(row.tier in lanes)) return null;
	const tier = row.tier as keyof typeof lanes;
	const id = `human:${row.user_id}`;
	const resolved = await resolveScopes(services.db.app, id, [tier]);
	return {
		kind: "human",
		id,
		tiers: [tier],
		lanes: [...lanes[tier]],
		scopes: resolved.scopes,
		zookie: resolved.zookie,
	};
}
