import type { IncomingMessage } from "node:http";

import { resolveScopes, type Principal } from "../src/lib/server/domain/auth/principal";
import type { Services } from "../src/lib/server/domain/substrate";

const lanes = {
	owner: ["viewer", "editor", "operator", "admin", "term_admin"],
	operator: ["viewer", "editor", "operator"],
	editor: ["viewer", "editor"],
	viewer: ["viewer"],
} as const;

export const principalResolver =
	(services: Services) =>
	async (request: IncomingMessage): Promise<Principal | null> => {
		const cookie = request.headers.cookie ?? "";
		const stored = cookie
			.split(";")
			.map((part) => part.trim().split("="))
			.find(
				([name]) => name === "console.session_token" || name === "__Host-console.session_token",
			);
		const token = stored?.slice(1).join("=").split(".")[0];
		if (!token) return null;
		const rows = await services.db.admin<Array<{ user_id: string; tier: string }>>`
		select s."userId" as user_id, u.tier
		from session s join "user" u on u.id = s."userId"
		where s.token = ${decodeURIComponent(token)} and s."expiresAt" > now()`;
		const row = rows[0];
		if (!row) return null;
		const tier = row.tier as keyof typeof lanes;
		if (!(tier in lanes)) return null;
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
	};
