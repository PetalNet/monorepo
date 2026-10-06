import { Schema } from "effect";
import { Cast, Check, Column, Query, Table, Type } from "effect-qb";
import * as Pg from "effect-qb/postgres";

import { Counter } from "../../sprouts/schema.ts";

// The canonical schema used by effect-db and runtime queries. Export field maps only
// where Actor set queries need portable projections without PostgreSQL timestamps.
const publicSchema = Pg.Schema.make("public");
const timestamp = () => Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now()));
const check = (name: string, expression: string) =>
	Check.make(name, Pg.SchemaExpression.fromSql(expression));

export const actorFields = {
	id: Column.text().pipe(Column.primaryKey),
	kind: Column.text().pipe(
		Column.schema(Schema.String.pipe(Schema.decodeTo(Schema.Literals(["person", "agent"])))),
	),
	name: Column.text(),
	lifecycle: Column.text().pipe(
		Column.schema(
			Schema.String.pipe(
				Schema.decodeTo(Schema.Literals(["active", "dormant", "suspended", "retired"])),
			),
		),
		Column.default(Query.literal("active").pipe(Cast.to(Type.text()))),
	),
	created_at: timestamp(),
	updated_at: timestamp(),
};
export const actors = publicSchema.table(
	"grove_actors",
	actorFields,
	check("grove_actors_kind_check", "kind = 'person'::text OR kind = 'agent'::text"),
	check(
		"grove_actors_lifecycle_check",
		"lifecycle = 'active'::text OR lifecycle = 'dormant'::text OR lifecycle = 'suspended'::text OR lifecycle = 'retired'::text",
	),
	check("grove_actors_name_check", "length(name) >= 1 AND length(name) <= 80"),
);

export const users = publicSchema.table("user", {
	id: Column.text().pipe(Column.primaryKey),
	name: Column.text(),
	email: Column.text().pipe(Pg.Column.unique.options({ name: "user_email_key" })),
	emailVerified: Column.boolean(),
	image: Column.text().pipe(Column.nullable),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const accounts = publicSchema.table(
	"account",
	{
		id: Column.text().pipe(Column.primaryKey),
		userId: Column.text().pipe(
			Pg.Column.foreignKey({
				target: () => users.id,
				name: "account_userId_fkey",
				onDelete: "cascade",
			}),
			Pg.Column.index({ name: "account_userId_idx", method: "btree", order: "asc", nulls: "last" }),
		),
		accountId: Column.text(),
		providerId: Column.text(),
		accessToken: Column.text().pipe(Column.nullable),
		refreshToken: Column.text().pipe(Column.nullable),
		accessTokenExpiresAt: Pg.Column.timestamptz().pipe(Column.nullable),
		refreshTokenExpiresAt: Pg.Column.timestamptz().pipe(Column.nullable),
		scope: Column.text().pipe(Column.nullable),
		idToken: Column.text().pipe(Column.nullable),
		password: Column.text().pipe(Column.nullable),
		createdAt: timestamp(),
		updatedAt: timestamp(),
	},
	Table.option({
		kind: "unique",
		columns: ["providerId", "accountId"] as const,
		name: "account_providerId_accountId_key",
	}),
);

export const sessions = publicSchema.table("session", {
	id: Column.text().pipe(Column.primaryKey),
	userId: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => users.id,
			name: "session_userId_fkey",
			onDelete: "cascade",
		}),
		Pg.Column.index({ name: "session_userId_idx", method: "btree", order: "asc", nulls: "last" }),
	),
	token: Column.text().pipe(Pg.Column.unique.options({ name: "session_token_key" })),
	expiresAt: Pg.Column.timestamptz(),
	ipAddress: Column.text().pipe(Column.nullable),
	userAgent: Column.text().pipe(Column.nullable),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const verifications = publicSchema.table("verification", {
	id: Column.text().pipe(Column.primaryKey),
	identifier: Column.text().pipe(
		Pg.Column.index({
			name: "verification_identifier_idx",
			method: "btree",
			order: "asc",
			nulls: "last",
		}),
	),
	value: Column.text(),
	expiresAt: Pg.Column.timestamptz(),
	createdAt: timestamp(),
	updatedAt: timestamp(),
});

export const persons = publicSchema.table("grove_persons", {
	actor_id: Column.text().pipe(
		Column.primaryKey,
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_persons_actor_id_fkey",
			onDelete: "restrict",
		}),
	),
	better_auth_user_id: Column.text().pipe(
		Pg.Column.unique.options({ name: "grove_persons_better_auth_user_id_key" }),
	),
});

export const identityFields = {
	actor_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_external_identities_actor_id_fkey",
			onDelete: "restrict",
		}),
		Pg.Column.index({
			name: "grove_external_identities_actor_idx",
			method: "btree",
			order: "asc",
			nulls: "last",
		}),
	),
	issuer: Column.text(),
	subject: Column.text(),
	use: Column.text().pipe(
		Column.schema(Schema.String.pipe(Schema.decodeTo(Schema.Literals(["browser", "machine"])))),
	),
	created_at: timestamp(),
};
export const identities = publicSchema.table(
	"grove_external_identities",
	identityFields,
	check(
		"grove_external_identities_use_check",
		"\"use\" = 'browser'::text OR \"use\" = 'machine'::text",
	),
	Table.option({
		kind: "unique",
		columns: ["issuer", "subject"] as const,
		name: "grove_external_identities_issuer_subject_key",
	}),
	Table.option({
		kind: "primaryKey",
		columns: ["actor_id", "issuer", "subject"] as const,
		name: "grove_external_identities_pkey",
	}),
);

export const hostFields = {
	id: Column.text().pipe(Column.primaryKey),
	runner_id: Column.text().pipe(Pg.Column.unique.options({ name: "grove_hosts_runner_id_key" })),
	owner_person_id: Column.text().pipe(
		Column.nullable,
		Pg.Column.foreignKey({
			target: () => persons.actor_id,
			name: "grove_hosts_owner_person_id_fkey",
			onDelete: "restrict",
		}),
	),
	created_at: timestamp(),
};
export const hosts = publicSchema.table("grove_hosts", hostFields);

export const agents = publicSchema.table("grove_agents", {
	actor_id: Column.text().pipe(
		Column.primaryKey,
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_agents_actor_id_fkey",
			onDelete: "restrict",
		}),
	),
	home_host_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => hosts.id,
			name: "grove_agents_home_host_id_fkey",
			onDelete: "restrict",
		}),
	),
	owner_person_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => persons.actor_id,
			name: "grove_agents_owner_person_id_fkey",
			onDelete: "restrict",
		}),
		Pg.Column.index({
			name: "grove_agents_owner_idx",
			method: "btree",
			order: "asc",
			nulls: "last",
		}),
	),
	acting_runtime_id: Column.text().pipe(
		Column.nullable,
		Pg.Column.unique.options({ name: "grove_agents_acting_runtime_id_key" }),
	),
});

export const capabilityFields = {
	actor_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_actor_capabilities_actor_id_fkey",
			onDelete: "restrict",
		}),
	),
	capability: Column.text(),
	created_at: timestamp(),
};
export const capabilities = publicSchema.table(
	"grove_actor_capabilities",
	capabilityFields,
	Table.option({
		kind: "primaryKey",
		columns: ["actor_id", "capability"] as const,
		name: "grove_actor_capabilities_pkey",
	}),
);

export const accessFields = {
	agent_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => agents.actor_id,
			name: "grove_agent_access_agent_id_fkey",
			onDelete: "restrict",
		}),
	),
	person_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => persons.actor_id,
			name: "grove_agent_access_person_id_fkey",
			onDelete: "restrict",
		}),
	),
	valid: Column.boolean().pipe(Column.default(Query.literal(true))),
	invalid_reason: Column.text().pipe(Column.nullable),
	created_at: timestamp(),
	updated_at: timestamp(),
};
export const access = publicSchema.table(
	"grove_agent_access",
	accessFields,
	check(
		"grove_agent_access_check",
		"(valid AND invalid_reason IS NULL) OR (NOT valid AND invalid_reason IS NOT NULL)",
	),
	Table.option({
		kind: "index",
		keys: [{ kind: "column", column: "person_id", order: "asc", nulls: "last" }] as const,
		name: "grove_agent_access_person_idx",
		method: "btree",
		predicate: Pg.SchemaExpression.fromSql("valid"),
	}),
	Table.option({
		kind: "primaryKey",
		columns: ["agent_id", "person_id"] as const,
		name: "grove_agent_access_pkey",
	}),
);

export const sprouts = publicSchema.table(
	"grove_demo_sprouts",
	{
		id: Pg.Column.int8().pipe(Pg.Column.identityAlways, Column.primaryKey),
		name: Column.text(),
		planted_at: timestamp(),
		waterings: Column.int().pipe(Column.default(Query.literal(0)), Column.schema(Counter)),
		created_by_actor_id: Column.text().pipe(
			Column.nullable,
			Pg.Column.foreignKey({
				target: () => actors.id,
				name: "grove_demo_sprouts_created_by_actor_id_fkey",
				onDelete: "restrict",
			}),
		),
		last_actor_id: Column.text().pipe(
			Column.nullable,
			Pg.Column.foreignKey({
				target: () => actors.id,
				name: "grove_demo_sprouts_last_actor_id_fkey",
				onDelete: "restrict",
			}),
		),
	},
	check("grove_demo_sprouts_waterings_nonnegative", "waterings >= 0"),
);
