import type { Sql } from "../db/pool.ts";
import type { Principal } from "./principal.ts";

export const GRANT_RELATIONS = ["viewer", "editor", "operator", "owner"] as const;
export type GrantRelation = (typeof GRANT_RELATIONS)[number];

interface TierRow {
	name: string;
	authentik_group: string | null;
	description: string;
	default_relations: GrantRelation[];
	propose_only: boolean;
}

const relationRank = new Map<GrantRelation, number>(
	GRANT_RELATIONS.map((relation, index) => [relation, index]),
);

export async function listTiers(sql: Sql): Promise<Record<string, unknown>> {
	const rows = await sql<TierRow[]>`
		select name, authentik_group, description, default_relations, propose_only
		from tiers order by name`;
	return { schema_version: 1, items: rows };
}

async function hasDirectCommitGrant(
	sql: Sql,
	principal: Principal,
	object: string | null,
	minimumRelation: GrantRelation,
): Promise<boolean> {
	if (!object) return false;
	const minimumRank = relationRank.get(minimumRelation) ?? Number.MAX_SAFE_INTEGER;
	const rows = await sql<{ allowed: boolean }[]>`
		select exists (
		  select 1 from grants g
		  where g.subject = ${principal.id}
		    and case g.relation
		      when 'viewer' then 0 when 'editor' then 1 when 'operator' then 2 when 'owner' then 3
		      else -1 end >= ${minimumRank}
		    and g.condition is null and g.valid_at <= now()
		    and (g.invalid_at is null or g.invalid_at > now())
		    and (g.object = ${object} or exists (
		      select 1 from items_min i
		      where ${object} = 'item:' || i.id and g.object = i.scope
		    ))
		) as allowed`;
	return rows[0]?.allowed === true;
}

/**
 * A tier's propose-only posture is the default, not a ceiling: a direct, unconditional
 * editor-or-stronger resource grant is the explicit trust elevation from task 724. When a principal
 * belongs to overlapping tiers, the tier with the strongest configured default relation wins; this
 * keeps the policy data-driven instead of hard-coding tier names.
 */
export async function shouldProposeMutation(
	sql: Sql,
	principal: Principal,
	object: string | null,
	minimumRelation: GrantRelation = "editor",
): Promise<boolean> {
	if (await hasDirectCommitGrant(sql, principal, object, minimumRelation)) return false;
	if (principal.tiers.length === 0) return false;
	const rows = await sql<Pick<TierRow, "default_relations" | "propose_only">[]>`
		select default_relations, propose_only from tiers
		where name = any(${sql.array([...principal.tiers])})`;
	let strongest = -1;
	for (const row of rows)
		for (const relation of row.default_relations)
			strongest = Math.max(strongest, relationRank.get(relation) ?? -1);
	if (strongest < 0) return false;
	const strongestRows = rows.filter((row) =>
		row.default_relations.some((relation) => relationRank.get(relation) === strongest),
	);
	// Equal-strength overlap is ambiguous, so the restrictive posture wins. A future non-propose
	// viewer tier must never silently turn a collaborator into a committer.
	return strongestRows.some((row) => row.propose_only);
}
