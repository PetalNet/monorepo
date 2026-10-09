/* oxlint-disable effecttsgo/unnecessary-pipe-chain -- Single-option pipes retain effect-qb 0.24.1 field inference. */
import { Table, Column, Cast, Query, Type, ForeignKey, Check } from "effect-qb";
import * as Pg from "effect-qb/postgres";
import * as Schema from "effect/Schema";

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

// Apply options one at a time: Table's single-option pipe overload preserves
// fields and dialect, whereas the generic multi-argument pipe erases them in 0.24.1.
// Mutable bindings let cyclic foreign keys resolve against the final definitions.
let grove_command_receipts = Table.make("grove_command_receipts", {
	command_id: Column.uuid(),
	operation: Column.text(),
	principal_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_command_receipts_principal_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	principal_kind: Column.text(),
	input_hash: Column.text(),
	object_id: Column.text().pipe(
		Column.nullable,
		Pg.Column.foreignKey({
			target: () => grove_objects.id,
			name: "grove_command_receipts_object_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	version_id: Column.text().pipe(Column.nullable),
	version_digest: Column.text().pipe(Column.nullable),
	created_at: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
	response: Pg.Column.jsonb(Schema.Unknown),
})
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_command_receipts_command_id_version_id_object_id_key",
			columns: ["command_id", "version_id", "object_id"],
		}),
	)
	.pipe(
		Table.option({
			kind: "primaryKey",
			name: "grove_command_receipts_pkey",
			columns: ["command_id"],
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

let grove_object_versions = Table.make("grove_object_versions", {
	id: Column.text(),
	object_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_objects.id,
			name: "grove_object_versions_object_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
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
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	actor_kind: Column.text(),
	created_at: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
})
	.pipe(
		check(
			"grove_object_versions_actor_kind_check",
			"actor_kind = ANY (ARRAY['person'::text, 'agent'::text])",
		),
	)
	.pipe(check("grove_object_versions_digest_check", "digest ~ '^[0-9a-f]{64}$'::text"))
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_object_versions_id_object_id_key",
			columns: ["id", "object_id"],
		}),
	)
	.pipe(Table.option({ kind: "primaryKey", name: "grove_object_versions_pkey", columns: ["id"] }))
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

let grove_objects = Table.make("grove_objects", {
	id: Column.text(),
	kind: Column.text(),
	scope: Column.text(),
	current_version_id: Column.text().pipe(Column.nullable),
	created_at: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
}).pipe(Table.option({ kind: "primaryKey", name: "grove_objects_pkey", columns: ["id"] }));

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

let grove_outbox = Table.make("grove_outbox", {
	id: Column.text(),
	command_id: Column.uuid().pipe(
		Pg.Column.foreignKey({
			target: () => grove_command_receipts.command_id,
			name: "grove_outbox_command_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: true,
			initiallyDeferred: true,
		}),
		Pg.Column.index({
			name: "grove_outbox_command_idx",
			method: "btree",
			order: "asc",
			nulls: "last",
		}),
	),
	version_id: Column.text(),
	event_type: Column.text(),
	aggregate_id: Column.text(),
	payload: Pg.Column.jsonb(Schema.Unknown),
	created_at: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
	published_at: Pg.Column.timestamptz().pipe(Column.nullable),
}).pipe(Table.option({ kind: "primaryKey", name: "grove_outbox_pkey", columns: ["id"] }));

grove_outbox = grove_outbox.pipe(
	ForeignKey.make(
		(table: typeof grove_outbox) => [table.version_id, table.aggregate_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_outbox_aggregate_version_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

let grove_tasks = Table.make("grove_tasks", {
	object_id: Column.text(),
	role: Column.text(),
	status: Column.text().pipe(Column.default(Query.literal("planning").pipe(Cast.to(Type.text())))),
	parent_task_id: Column.text().pipe(Column.nullable),
})
	.pipe(
		Table.option({ kind: "primaryKey", name: "grove_project_tasks_pkey", columns: ["object_id"] }),
	)
	.pipe(check("grove_tasks_role_check", "role = ANY (ARRAY['project'::text, 'work'::text])"))
	.pipe(
		check(
			"grove_tasks_status_check",
			"status = ANY (ARRAY['planning'::text, 'planned'::text, 'completed'::text])",
		),
	);

grove_tasks = grove_tasks.pipe(
	ForeignKey.make(
		(table: typeof grove_tasks) => table.object_id,
		() => grove_objects.id,
	).pipe(
		ForeignKey.named("grove_project_tasks_object_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_tasks) => table.parent_task_id,
		() => grove_tasks.object_id,
	).pipe(
		ForeignKey.named("grove_tasks_parent_task_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

let grove_attempts = Table.make("grove_attempts", {
	id: Column.text(),
	task_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_tasks.object_id,
			name: "grove_attempts_task_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	task_version_id: Column.text(),
	status: Column.text(),
	executor_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_attempts_executor_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	executor_kind: Column.text(),
	started_at: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
	result_submitted_at: Pg.Column.timestamptz().pipe(Column.nullable),
})
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_attempts_completion_target_key",
			columns: ["id", "task_id", "task_version_id"],
		}),
	)
	.pipe(
		check(
			"grove_attempts_executor_kind_check",
			"executor_kind = ANY (ARRAY['person'::text, 'agent'::text])",
		),
	)
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_attempts_id_task_id_key",
			columns: ["id", "task_id"],
		}),
	)
	.pipe(Table.option({ kind: "primaryKey", name: "grove_attempts_pkey", columns: ["id"] }))
	.pipe(
		check(
			"grove_attempts_status_check",
			"status = ANY (ARRAY['running'::text, 'result_submitted'::text, 'review_rejected'::text, 'accepted'::text, 'fenced'::text])",
		),
	)
	.pipe(
		Table.option({
			kind: "index",
			name: "grove_attempts_one_accepted_per_task",
			method: "btree",
			unique: true,
			keys: [{ kind: "column", column: "task_id", order: "asc", nulls: "last" }],
			predicate: Pg.SchemaExpression.fromSql("status = 'accepted'::text"),
		}),
	);

grove_attempts = grove_attempts.pipe(
	ForeignKey.make(
		(table: typeof grove_attempts) => [table.task_version_id, table.task_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_attempts_task_version_id_task_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

const grove_task_dependencies = Table.make("grove_task_dependencies", {
	task_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_tasks.object_id,
			name: "grove_task_dependencies_task_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	depends_on_task_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_tasks.object_id,
			name: "grove_task_dependencies_depends_on_task_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
		Pg.Column.index({
			name: "grove_task_dependencies_target_idx",
			method: "btree",
			order: "asc",
			nulls: "last",
		}),
	),
})
	.pipe(check("grove_task_dependencies_check", "task_id <> depends_on_task_id"))
	.pipe(
		Table.option({
			kind: "primaryKey",
			name: "grove_task_dependencies_pkey",
			columns: ["task_id", "depends_on_task_id"],
		}),
	);

let grove_attempt_outputs = Table.make("grove_attempt_outputs", {
	attempt_id: Column.text(),
	task_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_tasks.object_id,
			name: "grove_attempt_outputs_task_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	object_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_objects.id,
			name: "grove_attempt_outputs_object_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
		Pg.Column.unique.options({
			name: "grove_attempt_outputs_object_id_key",
			nullsNotDistinct: false,
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	version_id: Column.text(),
})
	.pipe(
		Table.option({
			kind: "primaryKey",
			name: "grove_attempt_outputs_pkey",
			columns: ["attempt_id"],
		}),
	)
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_attempt_outputs_review_target_key",
			columns: ["attempt_id", "task_id", "object_id", "version_id"],
		}),
	);

grove_attempt_outputs = grove_attempt_outputs.pipe(
	ForeignKey.make(
		(table: typeof grove_attempt_outputs) => [table.attempt_id, table.task_id] as const,
		() => [grove_attempts.id, grove_attempts.task_id],
	).pipe(
		ForeignKey.named("grove_attempt_outputs_attempt_id_task_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_attempt_outputs) => [table.version_id, table.object_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_attempt_outputs_version_id_object_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

let grove_claims = Table.make("grove_claims", {
	id: Column.text(),
	task_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_tasks.object_id,
			name: "grove_claims_task_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	attempt_id: Column.text().pipe(
		Pg.Column.unique.options({
			name: "grove_claims_attempt_id_key",
			nullsNotDistinct: false,
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	fence: Column.text().pipe(
		Pg.Column.unique.options({
			name: "grove_claims_fence_key",
			nullsNotDistinct: false,
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	holder_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_claims_holder_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	holder_kind: Column.text(),
	status: Column.text(),
	issued_at: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
	expires_at: Pg.Column.timestamptz(),
	released_at: Pg.Column.timestamptz().pipe(Column.nullable),
})
	.pipe(check("grove_claims_check", "expires_at > issued_at"))
	.pipe(
		check(
			"grove_claims_holder_kind_check",
			"holder_kind = ANY (ARRAY['person'::text, 'agent'::text])",
		),
	)
	.pipe(Table.option({ kind: "primaryKey", name: "grove_claims_pkey", columns: ["id"] }))
	.pipe(
		check(
			"grove_claims_status_check",
			"status = ANY (ARRAY['leased'::text, 'released'::text, 'expired'::text])",
		),
	)
	.pipe(
		Table.option({
			kind: "index",
			name: "grove_claims_one_leased_per_task",
			method: "btree",
			unique: true,
			keys: [{ kind: "column", column: "task_id", order: "asc", nulls: "last" }],
			predicate: Pg.SchemaExpression.fromSql("status = 'leased'::text"),
		}),
	);

grove_claims = grove_claims.pipe(
	ForeignKey.make(
		(table: typeof grove_claims) => [table.attempt_id, table.task_id] as const,
		() => [grove_attempts.id, grove_attempts.task_id],
	).pipe(
		ForeignKey.named("grove_claims_attempt_id_task_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

let grove_reviews = Table.make("grove_reviews", {
	object_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => grove_objects.id,
			name: "grove_reviews_object_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	version_id: Column.text(),
	reviewer_id: Column.text().pipe(
		Pg.Column.foreignKey({
			target: () => actors.id,
			name: "grove_reviews_reviewer_id_fkey",
			onUpdate: "noAction",
			onDelete: "noAction",
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	reviewer_kind: Column.text(),
	subject_object_id: Column.text(),
	subject_version_id: Column.text(),
	attempt_id: Column.text().pipe(
		Pg.Column.unique.options({
			name: "grove_reviews_attempt_id_key",
			nullsNotDistinct: false,
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	task_id: Column.text(),
	outcome: Column.text(),
	comments: Column.text().pipe(Column.nullable),
})
	.pipe(
		check(
			"grove_reviews_comments_check",
			"comments IS NULL OR (length(comments) >= 1 AND length(comments) <= 4000)",
		),
	)
	.pipe(
		Table.option({
			kind: "unique",
			name: "grove_reviews_completion_target_key",
			columns: [
				"object_id",
				"version_id",
				"attempt_id",
				"task_id",
				"subject_object_id",
				"subject_version_id",
				"outcome",
			],
		}),
	)
	.pipe(
		check(
			"grove_reviews_outcome_check",
			"outcome = ANY (ARRAY['accepted'::text, 'rejected'::text])",
		),
	)
	.pipe(Table.option({ kind: "primaryKey", name: "grove_reviews_pkey", columns: ["object_id"] }))
	.pipe(
		check(
			"grove_reviews_reviewer_kind_check",
			"reviewer_kind = ANY (ARRAY['person'::text, 'agent'::text])",
		),
	);

let grove_task_completions = Table.make("grove_task_completions", {
	completion_version_id: Column.text(),
	task_id: Column.text().pipe(
		Pg.Column.unique.options({
			name: "grove_task_completions_task_id_key",
			nullsNotDistinct: false,
			deferrable: false,
			initiallyDeferred: false,
		}),
	),
	task_version_id: Column.text(),
	attempt_id: Column.text(),
	output_object_id: Column.text(),
	output_version_id: Column.text(),
	review_object_id: Column.text(),
	review_version_id: Column.text(),
	outcome: Column.text().pipe(Column.default(Query.literal("accepted").pipe(Cast.to(Type.text())))),
})
	.pipe(check("grove_task_completions_outcome_check", "outcome = 'accepted'::text"))
	.pipe(
		Table.option({
			kind: "primaryKey",
			name: "grove_task_completions_pkey",
			columns: ["completion_version_id"],
		}),
	);

grove_reviews = grove_reviews.pipe(
	ForeignKey.make(
		(table: typeof grove_reviews) => [table.attempt_id, table.task_id] as const,
		() => [grove_attempts.id, grove_attempts.task_id],
	).pipe(
		ForeignKey.named("grove_reviews_attempt_id_task_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_reviews) =>
			[table.attempt_id, table.task_id, table.subject_object_id, table.subject_version_id] as const,
		() => [
			grove_attempt_outputs.attempt_id,
			grove_attempt_outputs.task_id,
			grove_attempt_outputs.object_id,
			grove_attempt_outputs.version_id,
		],
	).pipe(
		ForeignKey.named("grove_reviews_attempt_id_task_id_subject_object_id_subject_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_reviews) => [table.subject_version_id, table.subject_object_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_reviews_subject_version_id_subject_object_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_reviews) => [table.version_id, table.object_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_reviews_version_id_object_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

grove_task_completions = grove_task_completions.pipe(
	ForeignKey.make(
		(table: typeof grove_task_completions) =>
			[table.attempt_id, table.task_id, table.output_object_id, table.output_version_id] as const,
		() => [
			grove_attempt_outputs.attempt_id,
			grove_attempt_outputs.task_id,
			grove_attempt_outputs.object_id,
			grove_attempt_outputs.version_id,
		],
	).pipe(
		ForeignKey.named("grove_task_completions_attempt_id_task_id_output_object_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_task_completions) =>
			[table.attempt_id, table.task_id, table.task_version_id] as const,
		() => [grove_attempts.id, grove_attempts.task_id, grove_attempts.task_version_id],
	).pipe(
		ForeignKey.named("grove_task_completions_attempt_id_task_id_task_version_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_task_completions) => [table.completion_version_id, table.task_id] as const,
		() => [grove_object_versions.id, grove_object_versions.object_id],
	).pipe(
		ForeignKey.named("grove_task_completions_completion_version_id_task_id_fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
	ForeignKey.make(
		(table: typeof grove_task_completions) =>
			[
				table.review_object_id,
				table.review_version_id,
				table.attempt_id,
				table.task_id,
				table.output_object_id,
				table.output_version_id,
				table.outcome,
			] as const,
		() => [
			grove_reviews.object_id,
			grove_reviews.version_id,
			grove_reviews.attempt_id,
			grove_reviews.task_id,
			grove_reviews.subject_object_id,
			grove_reviews.subject_version_id,
			grove_reviews.outcome,
		],
	).pipe(
		ForeignKey.named("grove_task_completions_review_object_id_review_version_id__fkey"),
		ForeignKey.onUpdate("noAction"),
		ForeignKey.onDelete("noAction"),
	),
);

export {
	grove_command_receipts,
	grove_object_versions,
	grove_objects,
	grove_outbox,
	grove_tasks,
	grove_attempts,
	grove_task_dependencies,
	grove_attempt_outputs,
	grove_claims,
	grove_reviews,
	grove_task_completions,
};
