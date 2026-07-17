import { createHash } from "node:crypto";

import { z } from "zod";

import type { Db, Sql } from "../db/pool.ts";
import { SCOPE_RE } from "../scope.ts";
import type { Principal } from "./principal.ts";

const subjectSchema = z
	.string()
	.min(1)
	.max(160)
	.regex(/^(?:tier:|agent:|system:)?[a-z0-9][a-z0-9._:-]*$/);
const relationSchema = z.enum(["viewer", "editor", "operator", "owner"]);
const objectSchema = z.string().refine((value) => SCOPE_RE.test(value), "invalid grant object");

export const grantMutationSchema = z
	.object({
		schema_version: z.literal(1),
		id: z.uuid(),
		action: z.enum(["grant", "revoke"]),
		subject: subjectSchema,
		relation: relationSchema,
		object: objectSchema,
		condition: z.string().min(1).max(128).nullable().optional(),
		valid_at: z.iso.datetime({ offset: true }).optional(),
		invalid_at: z.iso.datetime({ offset: true }).nullable().optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (input.action === "revoke" && (input.valid_at || input.invalid_at || input.condition))
			ctx.addIssue({ code: "custom", message: "revoke accepts only the grant tuple" });
		if (input.invalid_at && !input.valid_at)
			ctx.addIssue({ code: "custom", message: "valid_at is required when invalid_at is supplied" });
		else if (
			input.valid_at &&
			input.invalid_at &&
			Date.parse(input.invalid_at) <= Date.parse(input.valid_at)
		)
			ctx.addIssue({ code: "custom", message: "invalid_at must be after valid_at" });
	});

export type GrantMutation = z.infer<typeof grantMutationSchema>;

interface GrantRow {
	id: string;
	subject: string;
	relation: string;
	object: string;
	condition: string | null;
	valid_at: string | Date;
	invalid_at: string | Date | null;
	granted_by: string;
	zookie: string;
}

export class GrantError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function wireDate(value: string | Date): string {
	return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function wireGrant(row: GrantRow): Record<string, unknown> {
	return {
		schema_version: 1,
		grant_id: row.id,
		subject: row.subject,
		relation: row.relation,
		object: row.object,
		condition: row.condition,
		valid_at: wireDate(row.valid_at),
		invalid_at: row.invalid_at ? wireDate(row.invalid_at) : null,
		granted_by: row.granted_by,
		zookie: row.zookie,
	};
}

async function ownsObject(sql: Sql, principal: Principal, object: string): Promise<boolean> {
	const subjects = [principal.id, ...principal.tiers.map((tier) => `tier:${tier}`)];
	const rows = await sql<{ allowed: boolean }[]>`
		select exists (
		  select 1 from grants
		  where subject = any(${sql.array(subjects)}) and relation = 'owner'
		    and object = ${object} and valid_at <= now()
		    and condition is null
		    and (invalid_at is null or invalid_at > now())
		) or exists (
		  select 1 from items_min i join grants g on g.object = i.scope
		  where ${object} = 'item:' || i.id and g.subject = any(${sql.array(subjects)})
		    and g.relation = 'owner' and g.valid_at <= now()
		    and g.condition is null
		    and (g.invalid_at is null or g.invalid_at > now())
		) as allowed`;
	return rows[0].allowed;
}

export async function canMutateScope(
	sql: Sql,
	principal: Principal,
	scope: string,
): Promise<boolean> {
	const subjects = [principal.id, ...principal.tiers.map((tier) => `tier:${tier}`)];
	const rows = await sql<{ allowed: boolean }[]>`
		select exists (
		  select 1 from grants where subject = any(${sql.array(subjects)})
		    and object = ${scope} and relation in ('editor', 'operator', 'owner')
		    and condition is null and valid_at <= now()
		    and (invalid_at is null or invalid_at > now())
		) as allowed`;
	return rows[0].allowed;
}

async function authorizationObjects(sql: Sql, object: string): Promise<string[]> {
	if (!object.startsWith("item:")) return [object];
	const rows = await sql<{ scope: string }[]>`
		select scope from items_min where ${object} = 'item:' || id`;
	return [...new Set([object, ...(rows[0] ? [rows[0].scope] : [])])].toSorted();
}

export async function canViewGrantObject(
	sql: Sql,
	principal: Principal,
	object: string,
): Promise<boolean> {
	if (principal.scopes.includes(object)) return true;
	if (!object.startsWith("item:")) return false;
	const rows = await sql<{ scope: string }[]>`
		select scope from items_min where ${object} = 'item:' || id`;
	return rows[0] ? principal.scopes.includes(rows[0].scope) : false;
}

export async function listGrants(
	writer: Sql,
	principal: Principal,
	object: string,
): Promise<Record<string, unknown>> {
	if (!SCOPE_RE.test(object)) throw new GrantError("bad_object", "invalid grant object");
	if (!(await ownsObject(writer, principal, object)))
		throw new GrantError("grant_denied", "owner relation required");
	const rows = await writer<GrantRow[]>`
		select id::text, subject, relation, object, condition, valid_at, invalid_at, granted_by,
		       zookie::text as zookie
		from grants where object = ${object} and valid_at <= now()
		  and (invalid_at is null or invalid_at > now())
		order by subject, relation, id`;
	const head = await writer<{ zookie: string }[]>`
		select zookie::text as zookie from grant_set_state where singleton`;
	return { schema_version: 1, object, zookie: head[0].zookie ?? "0", items: rows.map(wireGrant) };
}

function mutationHash(input: GrantMutation): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function mutateGrant(
	db: Pick<Db, "writer">,
	principal: Principal,
	input: GrantMutation,
): Promise<Record<string, unknown>> {
	const requestHash = mutationHash(input);
	return db.writer.begin(async (tx) => {
		const claimed = await tx<{ request_hash: string; result: Record<string, unknown> }[]>`
			insert into grant_mutations (principal_id, request_id, request_hash, result)
			values (${principal.id}, ${input.id}, ${requestHash}, ${tx.json({ pending: true })})
			on conflict (principal_id, request_id) do nothing
			returning request_hash, result`;
		if (!claimed[0]) {
			const existing = await tx<{ request_hash: string; result: Record<string, unknown> }[]>`
				select request_hash, result from grant_mutations
				where principal_id = ${principal.id} and request_id = ${input.id}`;
			if (!existing[0] || existing[0].request_hash !== requestHash)
				throw new GrantError("id_reused", "mutation id was already used with a different body");
			return existing[0].result;
		}
		// Lock the object and (for item sharing) its containing scope in deterministic order. A
		// concurrent revoke of the caller's direct or inherited owner edge cannot commit between the
		// authorization check and this mutation.
		for (const object of await authorizationObjects(tx as unknown as Sql, input.object))
			await tx`select pg_advisory_xact_lock(hashtextextended(${object}, 705706))`;
		if (!(await ownsObject(tx as unknown as Sql, principal, input.object)))
			throw new GrantError("grant_denied", "owner relation required");

		let result: Record<string, unknown>;
		if (input.action === "grant") {
			await tx`update grants set invalid_at = greatest(now(), valid_at + interval '1 microsecond')
				where subject = ${input.subject} and relation = ${input.relation} and object = ${input.object}
				  and (invalid_at is null or invalid_at > now())`;
			const rows = await tx<GrantRow[]>`
				insert into grants (subject, relation, object, condition, valid_at, invalid_at, granted_by)
				values (${input.subject}, ${input.relation}, ${input.object}, ${input.condition ?? null},
				        ${input.valid_at ?? new Date().toISOString()}, ${input.invalid_at ?? null}, ${principal.id})
				returning id::text, subject, relation, object, condition, valid_at, invalid_at, granted_by,
				          zookie::text as zookie`;
			result = { schema_version: 1, action: "granted", grant: wireGrant(rows[0]) };
		} else {
			const rows = await tx<{ id: string; zookie: string }[]>`
				update grants set invalid_at = greatest(now(), valid_at + interval '1 microsecond')
				where subject = ${input.subject} and relation = ${input.relation} and object = ${input.object}
				  and (invalid_at is null or invalid_at > now())
				returning id::text, zookie::text as zookie`;
			const head = await tx<{ zookie: string }[]>`
				select zookie::text as zookie from grant_set_state where singleton`;
			result = {
				schema_version: 1,
				action: "revoked",
				revoked_count: rows.length,
				zookie: head[0].zookie ?? "0",
			};
		}
		await tx`update grant_mutations set result = ${tx.json(result as never)}
			where principal_id = ${principal.id} and request_id = ${input.id}`;
		return result;
	});
}
