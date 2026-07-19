// Principal resolution (contract §1.2, §7). Server-stamped, never trusted from the client.
// `kind` is bound to the auth path (bearer mint record => agent/system; Better Auth => human).
// Token revocation is checked per request (sha256 lookup), independent of the grant zookie.

import { createHash } from "node:crypto";

import type { Sql } from "../db/pool.ts";
import { SCOPE_RE } from "../scope.ts";

export interface Principal {
	readonly kind: "human" | "agent" | "system";
	readonly id: string;
	readonly tiers: readonly string[];
	readonly lanes: readonly string[];
	readonly scopes: readonly string[];
	readonly zookie: string;
}

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

interface TokenRow {
	subject: string;
	kind: string;
	tiers: string[];
	lanes: string[];
}

/**
 * Readable scope tags for a subject: the union of grant objects (relation
 * viewer|editor|operator|owner, currently valid) held by the subject directly or by any tier the
 * subject belongs to.
 */
export async function resolveScopes(
	sql: Sql,
	subject: string,
	tiers: readonly string[],
	relations: readonly string[] = ["viewer", "editor", "operator", "owner"],
	includeConditional = true,
): Promise<{ scopes: string[]; zookie: string }> {
	const subjects = [subject, ...tiers.map((t) => `tier:${t}`)];
	const rows = await sql<{ object: string | null; head: string }[]>`
		select g.object, s.zookie::text as head
		from grant_set_state s
		left join grants g on g.subject = any(${sql.array(subjects)})
		  and g.relation = any(${sql.array([...relations])})
		  and (${includeConditional} or g.condition is null)
		  and g.valid_at <= now()
		  and (g.invalid_at is null or g.invalid_at > now())
		where s.singleton`;
	const scopes = new Set<string>();
	// An agent always has its own private scope. This intrinsic edge avoids a grant/token bootstrap
	// cycle while remaining flat: it grants no fleet or other-agent visibility.
	if (subject.startsWith("agent:") && SCOPE_RE.test(subject)) scopes.add(subject);
	for (const r of rows) {
		// Only well-formed scope-tag objects are readable scopes (item:/op: objects gate ops, not
		// reads). SCOPE_RE is ANCHORED, so a malformed grant object with an embedded comma cannot
		// inject a phantom scope into the app.scopes GUC (sub-agent M4).
		if (r.object && SCOPE_RE.test(r.object)) scopes.add(r.object);
	}
	return { scopes: [...scopes].toSorted(), zookie: rows[0].head };
}

export async function resolveBearer(sql: Sql, tokenPlaintext: string): Promise<Principal | null> {
	const hash = sha256(tokenPlaintext);
	const rows = await sql<TokenRow[]>`
		select subject, kind, tiers, lanes from api_tokens
		where token_sha256 = ${hash} and revoked_at is null`;
	const row = rows.at(0);
	// An unknown or revoked token is an authentication failure (401), never a crash.
	if (!row) return null;
	if (row.kind !== "human" && row.kind !== "agent" && row.kind !== "system") return null;
	const { scopes, zookie } = await resolveScopes(sql, row.subject, row.tiers);
	return { kind: row.kind, id: row.subject, tiers: row.tiers, lanes: row.lanes, scopes, zookie };
}

/** Dev/test only: a fully-specified principal via header, gated by CONSOLE_API_DEV_AUTH. */
export function devPrincipal(json: string): Principal | null {
	try {
		const p = JSON.parse(json) as Partial<Principal>;
		if (!p.kind || !p.id) return null;
		return {
			kind: p.kind,
			id: p.id,
			tiers: p.tiers ?? [],
			lanes: p.lanes ?? [],
			// SCOPE_RE-validated so a dev header cannot inject a comma into the GUC (sub-agent M4)
			scopes: (p.scopes ?? []).filter((s) => SCOPE_RE.test(s)),
			zookie: p.zookie ?? "1",
		};
	} catch {
		return null;
	}
}

export { sha256 };
