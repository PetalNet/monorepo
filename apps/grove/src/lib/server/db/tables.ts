/* oxlint-disable effecttsgo/unnecessary-pipe-chain -- Single-option pipes retain effect-qb 0.24.1 field inference. */
import { Schema } from "effect";
import { Cast, Check, Column, ForeignKey, Query, Table, Type } from "effect-qb";
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

// Single-option pipes preserve typed fields across cyclic foreign keys.
export let grove_objects = Table.make("grove_objects", {
	id: Column.text(),
	kind: Column.text(),
	scope: Column.text(),
	current_version_id: Column.text().pipe(Column.nullable),
	created_at: timestamp(),
}).pipe(Table.option({ kind: "primaryKey", name: "grove_objects_pkey", columns: ["id"] }));
export let grove_object_versions = Table.make("grove_object_versions", {
	id: Column.text(),
	object_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_objects.id,
			name: "grove_object_versions_object_id_fkey",
			onDelete: "noAction",
			onUpdate: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	parent_version_id: Column.text().pipe(Column.nullable),
	payload: Pg.Column.jsonb(Schema.Unknown),
	digest: Column.text(),
	actor_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_object_versions_actor_id_fkey",
			onDelete: "noAction",
			onUpdate: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	actor_kind: Column.text(),
	created_at: timestamp(),
})
	.pipe(Table.option({ kind: "primaryKey", name: "grove_object_versions_pkey", columns: ["id"] }))
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_object_versions_id_object_id_key",
			columns: ["id", "object_id"],
		}),
	)
	.pipe(
		check(
			"grove_object_versions_actor_kind_check",
			"actor_kind = ANY (ARRAY['person'::text, 'agent'::text])",
		),
	)
	.pipe(check("grove_object_versions_digest_check", "digest ~ '^[0-9a-f]{64}$'::text"))
	.pipe(
		Table.option({
			kind: "index",
			name: "grove_object_versions_object_created_idx",
			method: "btree",
			keys: [
				{ kind: "column", column: "object_id", order: "asc", nulls: "last" },
				{ kind: "column", column: "created_at", order: "asc", nulls: "last" },
				{ kind: "column", column: "id", order: "asc", nulls: "last" },
			],
		}),
	)
	.pipe(
		Table.option({
			kind: "index",
			name: "grove_object_versions_parent_idx",
			method: "btree",
			keys: [{ kind: "column", column: "parent_version_id", order: "asc", nulls: "last" }],
			predicate: Pg.SchemaExpression.fromSql("parent_version_id IS NOT NULL"),
		}),
	);

grove_object_versions = grove_object_versions.pipe(
	ForeignKey.make(
		(table: typeof grove_object_versions) => [table.parent_version_id, table.object_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_object_versions_parent_version_id_object_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

grove_objects = grove_objects.pipe(
	ForeignKey.make(
		(table: typeof grove_objects) => [table.current_version_id, table.id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_objects_current_version_fk"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

export const grove_project_tasks = Table.make("grove_project_tasks", {
	object_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_objects.id,
			name: "grove_project_tasks_object_id_fkey",
			onDelete: "noAction",
			onUpdate: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	role: Column.text().pipe(Column.default(Query.literal("project").pipe(Cast.to(Type.text())))),
	status: Column.text().pipe(Column.default(Query.literal("open").pipe(Cast.to(Type.text())))),
})
	.pipe(
		Table.option({ kind: "primaryKey", name: "grove_project_tasks_pkey", columns: ["object_id"] }),
	)
	.pipe(check("grove_project_tasks_role_check", "role = 'project'::text"))
	.pipe(check("grove_project_tasks_status_check", "status = 'open'::text"));
export let grove_command_receipts = Table.make("grove_command_receipts", {
	command_id: Column.uuid(),
	operation: Column.text(),
	principal_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_command_receipts_principal_id_fkey",
			onDelete: "noAction",
			onUpdate: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	principal_kind: Column.text(),
	input_hash: Column.text(),
	object_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_objects.id,
			name: "grove_command_receipts_object_id_fkey",
			onDelete: "noAction",
			onUpdate: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	version_id: Column.text(),
	version_digest: Column.text(),
	created_at: timestamp(),
})
	.pipe(
		Table.option({
			kind: "primaryKey",
			name: "grove_command_receipts_pkey",
			columns: ["command_id"],
		}),
	)
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_command_receipts_command_id_version_id_object_id_key",
			columns: ["command_id", "version_id", "object_id"],
		}),
	)
	.pipe(
		check(
			"grove_command_receipts_principal_kind_check",
			"principal_kind = ANY (ARRAY['person'::text, 'agent'::text])",
		),
	);

grove_command_receipts = grove_command_receipts.pipe(
	ForeignKey.make(
		(table: typeof grove_command_receipts) => [table.version_id, table.object_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_command_receipts_version_id_object_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

export let grove_outbox = Table.make("grove_outbox", {
	id: Column.text(),
	command_id: Column.uuid().pipe(Pg.Column.unique.options({ name: "grove_outbox_command_id_key" })),
	version_id: Column.text(),
	event_type: Column.text(),
	aggregate_id: Column.text(),
	payload: Pg.Column.jsonb(Schema.Unknown),
	created_at: timestamp(),
	published_at: Pg.Column.timestamptz().pipe(Column.nullable),
}).pipe(Table.option({ kind: "primaryKey", name: "grove_outbox_pkey", columns: ["id"] }));

grove_outbox = grove_outbox.pipe(
	ForeignKey.make(
		(table: typeof grove_outbox) =>
			[table.command_id, table.version_id, table.aggregate_id] as const,
		() => [
			grove_command_receipts.command_id,
			grove_command_receipts.version_id,
			grove_command_receipts.object_id,
		],
	).pipe(
		ForeignKey.named("grove_outbox_command_id_version_id_aggregate_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
		Pg.ForeignKey.initiallyDeferred,
	),
);
