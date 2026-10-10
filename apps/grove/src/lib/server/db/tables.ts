import { sql } from "drizzle-orm";
import {
	pgTable,
	unique,
	text,
	boolean,
	timestamp,
	index,
	foreignKey,
	check,
	type PgTableExtraConfigValue,
	jsonb,
	uuid,
	uniqueIndex,
	primaryKey,
} from "drizzle-orm/pg-core";

const user = pgTable(
	"user",
	{
		id: text().primaryKey().notNull(),
		name: text().notNull(),
		email: text().notNull(),
		emailVerified: boolean().notNull(),
		image: text(),
		createdAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
	},
	(table) => [unique("user_email_key").on(table.email)],
);

const account = pgTable(
	"account",
	{
		id: text().primaryKey().notNull(),
		userId: text().notNull(),
		accountId: text().notNull(),
		providerId: text().notNull(),
		accessToken: text(),
		refreshToken: text(),
		accessTokenExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
		refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
		scope: text(),
		idToken: text(),
		password: text(),
		createdAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
	},
	(table) => [
		index("account_userId_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
		foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_userId_fkey",
		}).onDelete("cascade"),
		unique("account_providerId_accountId_key").on(table.providerId, table.accountId),
	],
);

const grove_actors = pgTable(
	"grove_actors",
	{
		id: text().primaryKey().notNull(),
		kind: text({ enum: ["person", "agent"] }).notNull(),
		name: text().notNull(),
		lifecycle: text({ enum: ["active", "dormant", "suspended", "retired"] })
			.default("active")
			.notNull(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(_table) => [
		check("grove_actors_kind_check", sql`(kind = 'person'::text) OR (kind = 'agent'::text)`),
		check(
			"grove_actors_lifecycle_check",
			sql`(lifecycle = 'active'::text) OR (lifecycle = 'dormant'::text) OR (lifecycle = 'suspended'::text) OR (lifecycle = 'retired'::text)`,
		),
		check("grove_actors_name_check", sql`(length(name) >= 1) AND (length(name) <= 80)`),
	],
);

const grove_persons = pgTable(
	"grove_persons",
	{
		actor_id: text().primaryKey().notNull(),
		better_auth_user_id: text().notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.actor_id],
			foreignColumns: [grove_actors.id],
			name: "grove_persons_actor_id_fkey",
		}).onDelete("restrict"),
		unique("grove_persons_better_auth_user_id_key").on(table.better_auth_user_id),
	],
);

const grove_hosts = pgTable(
	"grove_hosts",
	{
		id: text().primaryKey().notNull(),
		runner_id: text().notNull(),
		owner_person_id: text(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.owner_person_id],
			foreignColumns: [grove_persons.actor_id],
			name: "grove_hosts_owner_person_id_fkey",
		}).onDelete("restrict"),
		unique("grove_hosts_runner_id_key").on(table.runner_id),
	],
);

const grove_agents = pgTable(
	"grove_agents",
	{
		actor_id: text().primaryKey().notNull(),
		home_host_id: text().notNull(),
		owner_person_id: text().notNull(),
		acting_runtime_id: text(),
	},
	(table) => [
		index("grove_agents_owner_idx").using(
			"btree",
			table.owner_person_id.asc().nullsLast().op("text_ops"),
		),
		foreignKey({
			columns: [table.actor_id],
			foreignColumns: [grove_actors.id],
			name: "grove_agents_actor_id_fkey",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.home_host_id],
			foreignColumns: [grove_hosts.id],
			name: "grove_agents_home_host_id_fkey",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.owner_person_id],
			foreignColumns: [grove_persons.actor_id],
			name: "grove_agents_owner_person_id_fkey",
		}).onDelete("restrict"),
		unique("grove_agents_acting_runtime_id_key").on(table.acting_runtime_id),
	],
);

const session = pgTable(
	"session",
	{
		id: text().primaryKey().notNull(),
		userId: text().notNull(),
		token: text().notNull(),
		expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
		ipAddress: text(),
		userAgent: text(),
		createdAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
	},
	(table) => [
		index("session_userId_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
		foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_userId_fkey",
		}).onDelete("cascade"),
		unique("session_token_key").on(table.token),
	],
);

const verification = pgTable(
	"verification",
	{
		id: text().primaryKey().notNull(),
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
		createdAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
		updatedAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
	},
	(table) => [
		index("verification_identifier_idx").using(
			"btree",
			table.identifier.asc().nullsLast().op("text_ops"),
		),
	],
);

export const grove_objects = pgTable(
	"grove_objects",
	{
		id: text().primaryKey().notNull(),
		kind: text().notNull(),
		scope: text().notNull(),
		current_version_id: text(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			columns: [table.current_version_id, table.id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_objects_current_version_fk",
		}),
	],
);

export const grove_object_versions = pgTable(
	"grove_object_versions",
	{
		id: text().primaryKey().notNull(),
		object_id: text().notNull(),
		parent_version_id: text(),
		payload: jsonb().notNull(),
		digest: text().notNull(),
		actor_id: text().notNull(),
		actor_kind: text().notNull(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("grove_object_versions_object_created_idx").using(
			"btree",
			table.object_id.asc().nullsLast().op("text_ops"),
			table.created_at.asc().nullsLast().op("timestamptz_ops"),
			table.id.asc().nullsLast().op("text_ops"),
		),
		index("grove_object_versions_parent_idx")
			.using("btree", table.parent_version_id.asc().nullsLast().op("text_ops"))
			.where(sql`(parent_version_id IS NOT NULL)`),
		foreignKey({
			columns: [table.object_id],
			foreignColumns: [grove_objects.id],
			name: "grove_object_versions_object_id_fkey",
		}),
		foreignKey({
			columns: [table.actor_id],
			foreignColumns: [grove_actors.id],
			name: "grove_object_versions_actor_id_fkey",
		}),
		foreignKey({
			columns: [table.parent_version_id, table.object_id],
			foreignColumns: [table.id, table.object_id],
			name: "grove_object_versions_parent_version_id_object_id_fkey",
		}),
		unique("grove_object_versions_id_object_id_key").on(table.id, table.object_id),
		check("grove_object_versions_digest_check", sql`digest ~ '^[0-9a-f]{64}$'::text`),
		check(
			"grove_object_versions_actor_kind_check",
			sql`actor_kind = ANY (ARRAY['person'::text, 'agent'::text])`,
		),
	],
);

export const grove_outbox = pgTable(
	"grove_outbox",
	{
		id: text().primaryKey().notNull(),
		command_id: uuid().notNull(),
		version_id: text().notNull(),
		event_type: text().notNull(),
		aggregate_id: text().notNull(),
		payload: jsonb().notNull(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
		published_at: timestamp({ withTimezone: true, mode: "string" }),
	},
	(table) => [
		index("grove_outbox_command_idx").using(
			"btree",
			table.command_id.asc().nullsLast().op("uuid_ops"),
		),
		// DEFERRABLE INITIALLY DEFERRED is owned by reviewed SQL (not supported by pg-core).
		foreignKey({
			columns: [table.command_id],
			foreignColumns: [grove_command_receipts.command_id],
			name: "grove_outbox_command_id_fkey",
		}),
		foreignKey({
			columns: [table.version_id, table.aggregate_id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_outbox_aggregate_version_fkey",
		}),
	],
);

export const grove_tasks = pgTable(
	"grove_tasks",
	{
		object_id: text().notNull(),
		role: text().notNull(),
		status: text().default("planning").notNull(),
		parent_task_id: text(),
	},
	(table) => [
		primaryKey({ columns: [table.object_id], name: "grove_project_tasks_pkey" }),
		foreignKey({
			columns: [table.object_id],
			foreignColumns: [grove_objects.id],
			name: "grove_project_tasks_object_id_fkey",
		}),
		foreignKey({
			columns: [table.parent_task_id],
			foreignColumns: [table.object_id],
			name: "grove_tasks_parent_task_id_fkey",
		}),
		check("grove_tasks_role_check", sql`role = ANY (ARRAY['project'::text, 'work'::text])`),
		check(
			"grove_tasks_status_check",
			sql`status = ANY (ARRAY['planning'::text, 'planned'::text, 'completed'::text])`,
		),
	],
);

export const grove_claims = pgTable(
	"grove_claims",
	{
		id: text().primaryKey().notNull(),
		task_id: text().notNull(),
		attempt_id: text().notNull(),
		fence: text().notNull(),
		holder_id: text().notNull(),
		holder_kind: text().notNull(),
		status: text().notNull(),
		issued_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
		expires_at: timestamp({ withTimezone: true, mode: "string" }).notNull(),
		released_at: timestamp({ withTimezone: true, mode: "string" }),
	},
	(table) => [
		uniqueIndex("grove_claims_one_leased_per_task")
			.using("btree", table.task_id.asc().nullsLast().op("text_ops"))
			.where(sql`(status = 'leased'::text)`),
		foreignKey({
			columns: [table.task_id],
			foreignColumns: [grove_tasks.object_id],
			name: "grove_claims_task_id_fkey",
		}),
		foreignKey({
			columns: [table.holder_id],
			foreignColumns: [grove_actors.id],
			name: "grove_claims_holder_id_fkey",
		}),
		foreignKey({
			columns: [table.attempt_id, table.task_id],
			foreignColumns: [grove_attempts.id, grove_attempts.task_id],
			name: "grove_claims_attempt_id_task_id_fkey",
		}),
		unique("grove_claims_attempt_id_key").on(table.attempt_id),
		unique("grove_claims_fence_key").on(table.fence),
		check(
			"grove_claims_holder_kind_check",
			sql`holder_kind = ANY (ARRAY['person'::text, 'agent'::text])`,
		),
		check(
			"grove_claims_status_check",
			sql`status = ANY (ARRAY['leased'::text, 'released'::text, 'expired'::text])`,
		),
		check("grove_claims_check", sql`expires_at > issued_at`),
	],
);

export const grove_attempt_outputs = pgTable(
	"grove_attempt_outputs",
	{
		attempt_id: text().primaryKey().notNull(),
		task_id: text().notNull(),
		object_id: text().notNull(),
		version_id: text().notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.task_id],
			foreignColumns: [grove_tasks.object_id],
			name: "grove_attempt_outputs_task_id_fkey",
		}),
		foreignKey({
			columns: [table.object_id],
			foreignColumns: [grove_objects.id],
			name: "grove_attempt_outputs_object_id_fkey",
		}),
		foreignKey({
			columns: [table.version_id, table.object_id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_attempt_outputs_version_id_object_id_fkey",
		}),
		foreignKey({
			columns: [table.attempt_id, table.task_id],
			foreignColumns: [grove_attempts.id, grove_attempts.task_id],
			name: "grove_attempt_outputs_attempt_id_task_id_fkey",
		}),
		unique("grove_attempt_outputs_review_target_key").on(
			table.attempt_id,
			table.task_id,
			table.object_id,
			table.version_id,
		),
		unique("grove_attempt_outputs_object_id_key").on(table.object_id),
	],
);

export const grove_command_receipts = pgTable(
	"grove_command_receipts",
	{
		command_id: uuid().primaryKey().notNull(),
		operation: text().notNull(),
		principal_id: text().notNull(),
		principal_kind: text().notNull(),
		input_hash: text().notNull(),
		object_id: text(),
		version_id: text(),
		version_digest: text(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
		response: jsonb().notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			columns: [table.principal_id],
			foreignColumns: [grove_actors.id],
			name: "grove_command_receipts_principal_id_fkey",
		}),
		foreignKey({
			columns: [table.object_id],
			foreignColumns: [grove_objects.id],
			name: "grove_command_receipts_object_id_fkey",
		}),
		foreignKey({
			columns: [table.version_id, table.object_id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_command_receipts_version_id_object_id_fkey",
		}),
		unique("grove_command_receipts_command_id_version_id_object_id_key").on(
			table.command_id,
			table.version_id,
			table.object_id,
		),
		check(
			"grove_command_receipts_principal_kind_check",
			sql`principal_kind = ANY (ARRAY['person'::text, 'agent'::text])`,
		),
	],
);

export const grove_attempts = pgTable(
	"grove_attempts",
	{
		id: text().primaryKey().notNull(),
		task_id: text().notNull(),
		task_version_id: text().notNull(),
		status: text().notNull(),
		executor_id: text().notNull(),
		executor_kind: text().notNull(),
		started_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
		result_submitted_at: timestamp({ withTimezone: true, mode: "string" }),
	},
	(table) => [
		uniqueIndex("grove_attempts_one_accepted_per_task")
			.using("btree", table.task_id.asc().nullsLast().op("text_ops"))
			.where(sql`(status = 'accepted'::text)`),
		foreignKey({
			columns: [table.task_id],
			foreignColumns: [grove_tasks.object_id],
			name: "grove_attempts_task_id_fkey",
		}),
		foreignKey({
			columns: [table.executor_id],
			foreignColumns: [grove_actors.id],
			name: "grove_attempts_executor_id_fkey",
		}),
		foreignKey({
			columns: [table.task_version_id, table.task_id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_attempts_task_version_id_task_id_fkey",
		}),
		unique("grove_attempts_id_task_id_key").on(table.id, table.task_id),
		unique("grove_attempts_completion_target_key").on(
			table.id,
			table.task_id,
			table.task_version_id,
		),
		check(
			"grove_attempts_executor_kind_check",
			sql`executor_kind = ANY (ARRAY['person'::text, 'agent'::text])`,
		),
		check(
			"grove_attempts_status_check",
			sql`status = ANY (ARRAY['running'::text, 'result_submitted'::text, 'review_rejected'::text, 'accepted'::text, 'fenced'::text])`,
		),
	],
);

export const grove_reviews = pgTable(
	"grove_reviews",
	{
		object_id: text().primaryKey().notNull(),
		version_id: text().notNull(),
		reviewer_id: text().notNull(),
		reviewer_kind: text().notNull(),
		subject_object_id: text().notNull(),
		subject_version_id: text().notNull(),
		attempt_id: text().notNull(),
		task_id: text().notNull(),
		outcome: text().notNull(),
		comments: text(),
	},
	(table) => [
		foreignKey({
			columns: [table.object_id],
			foreignColumns: [grove_objects.id],
			name: "grove_reviews_object_id_fkey",
		}),
		foreignKey({
			columns: [table.reviewer_id],
			foreignColumns: [grove_actors.id],
			name: "grove_reviews_reviewer_id_fkey",
		}),
		foreignKey({
			columns: [table.version_id, table.object_id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_reviews_version_id_object_id_fkey",
		}),
		foreignKey({
			columns: [table.subject_version_id, table.subject_object_id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_reviews_subject_version_id_subject_object_id_fkey",
		}),
		foreignKey({
			columns: [table.attempt_id, table.task_id],
			foreignColumns: [grove_attempts.id, grove_attempts.task_id],
			name: "grove_reviews_attempt_id_task_id_fkey",
		}),
		foreignKey({
			columns: [table.attempt_id, table.task_id, table.subject_object_id, table.subject_version_id],
			foreignColumns: [
				grove_attempt_outputs.attempt_id,
				grove_attempt_outputs.task_id,
				grove_attempt_outputs.object_id,
				grove_attempt_outputs.version_id,
			],
			name: "grove_reviews_attempt_id_task_id_subject_object_id_subject_fkey",
		}),
		unique("grove_reviews_completion_target_key").on(
			table.object_id,
			table.version_id,
			table.attempt_id,
			table.task_id,
			table.subject_object_id,
			table.subject_version_id,
			table.outcome,
		),
		unique("grove_reviews_attempt_id_key").on(table.attempt_id),
		check(
			"grove_reviews_reviewer_kind_check",
			sql`reviewer_kind = ANY (ARRAY['person'::text, 'agent'::text])`,
		),
		check(
			"grove_reviews_outcome_check",
			sql`outcome = ANY (ARRAY['accepted'::text, 'rejected'::text])`,
		),
		check(
			"grove_reviews_comments_check",
			sql`(comments IS NULL) OR ((length(comments) >= 1) AND (length(comments) <= 4000))`,
		),
	],
);

export const grove_task_completions = pgTable(
	"grove_task_completions",
	{
		completion_version_id: text().primaryKey().notNull(),
		task_id: text().notNull(),
		task_version_id: text().notNull(),
		attempt_id: text().notNull(),
		output_object_id: text().notNull(),
		output_version_id: text().notNull(),
		review_object_id: text().notNull(),
		review_version_id: text().notNull(),
		outcome: text().default("accepted").notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.completion_version_id, table.task_id],
			foreignColumns: [grove_object_versions.id, grove_object_versions.object_id],
			name: "grove_task_completions_completion_version_id_task_id_fkey",
		}),
		foreignKey({
			columns: [table.attempt_id, table.task_id, table.task_version_id],
			foreignColumns: [grove_attempts.id, grove_attempts.task_id, grove_attempts.task_version_id],
			name: "grove_task_completions_attempt_id_task_id_task_version_id_fkey",
		}),
		foreignKey({
			columns: [table.attempt_id, table.task_id, table.output_object_id, table.output_version_id],
			foreignColumns: [
				grove_attempt_outputs.attempt_id,
				grove_attempt_outputs.task_id,
				grove_attempt_outputs.object_id,
				grove_attempt_outputs.version_id,
			],
			name: "grove_task_completions_attempt_id_task_id_output_object_id_fkey",
		}),
		foreignKey({
			columns: [
				table.review_object_id,
				table.review_version_id,
				table.attempt_id,
				table.task_id,
				table.output_object_id,
				table.output_version_id,
				table.outcome,
			],
			foreignColumns: [
				grove_reviews.object_id,
				grove_reviews.version_id,
				grove_reviews.attempt_id,
				grove_reviews.task_id,
				grove_reviews.subject_object_id,
				grove_reviews.subject_version_id,
				grove_reviews.outcome,
			],
			name: "grove_task_completions_review_object_id_review_version_id__fkey",
		}),
		unique("grove_task_completions_task_id_key").on(table.task_id),
		check("grove_task_completions_outcome_check", sql`outcome = 'accepted'::text`),
	],
);

export const grove_task_dependencies = pgTable(
	"grove_task_dependencies",
	{
		task_id: text().notNull(),
		depends_on_task_id: text().notNull(),
	},
	(table) => [
		index("grove_task_dependencies_target_idx").using(
			"btree",
			table.depends_on_task_id.asc().nullsLast().op("text_ops"),
		),
		foreignKey({
			columns: [table.task_id],
			foreignColumns: [grove_tasks.object_id],
			name: "grove_task_dependencies_task_id_fkey",
		}),
		foreignKey({
			columns: [table.depends_on_task_id],
			foreignColumns: [grove_tasks.object_id],
			name: "grove_task_dependencies_depends_on_task_id_fkey",
		}),
		primaryKey({
			columns: [table.task_id, table.depends_on_task_id],
			name: "grove_task_dependencies_pkey",
		}),
		check("grove_task_dependencies_check", sql`task_id <> depends_on_task_id`),
	],
);

const grove_actor_capabilities = pgTable(
	"grove_actor_capabilities",
	{
		actor_id: text().notNull(),
		capability: text().notNull(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table) => [
		foreignKey({
			columns: [table.actor_id],
			foreignColumns: [grove_actors.id],
			name: "grove_actor_capabilities_actor_id_fkey",
		}).onDelete("restrict"),
		primaryKey({
			columns: [table.actor_id, table.capability],
			name: "grove_actor_capabilities_pkey",
		}),
	],
);

const grove_external_identities = pgTable(
	"grove_external_identities",
	{
		actor_id: text().notNull(),
		issuer: text().notNull(),
		subject: text().notNull(),
		use: text({ enum: ["browser", "machine"] }).notNull(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table) => [
		index("grove_external_identities_actor_idx").using(
			"btree",
			table.actor_id.asc().nullsLast().op("text_ops"),
		),
		foreignKey({
			columns: [table.actor_id],
			foreignColumns: [grove_actors.id],
			name: "grove_external_identities_actor_id_fkey",
		}).onDelete("restrict"),
		primaryKey({
			columns: [table.actor_id, table.issuer, table.subject],
			name: "grove_external_identities_pkey",
		}),
		unique("grove_external_identities_issuer_subject_key").on(table.issuer, table.subject),
		check(
			"grove_external_identities_use_check",
			sql`(use = 'browser'::text) OR (use = 'machine'::text)`,
		),
	],
);

const grove_agent_access = pgTable(
	"grove_agent_access",
	{
		agent_id: text().notNull(),
		person_id: text().notNull(),
		valid: boolean().default(true).notNull(),
		invalid_reason: text(),
		created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
	},
	(table) => [
		index("grove_agent_access_person_idx")
			.using("btree", table.person_id.asc().nullsLast().op("text_ops"))
			.where(sql`valid`),
		foreignKey({
			columns: [table.agent_id],
			foreignColumns: [grove_agents.actor_id],
			name: "grove_agent_access_agent_id_fkey",
		}).onDelete("restrict"),
		foreignKey({
			columns: [table.person_id],
			foreignColumns: [grove_persons.actor_id],
			name: "grove_agent_access_person_id_fkey",
		}).onDelete("restrict"),
		primaryKey({ columns: [table.agent_id, table.person_id], name: "grove_agent_access_pkey" }),
		check(
			"grove_agent_access_check",
			sql`(valid AND (invalid_reason IS NULL)) OR ((NOT valid) AND (invalid_reason IS NOT NULL))`,
		),
	],
);

export const authTables = { user, account, session, verification };

export {
	user as users,
	account as accounts,
	session as sessions,
	verification as verifications,
	grove_actors as actors,
	grove_persons as persons,
	grove_hosts as hosts,
	grove_agents as agents,
	grove_actor_capabilities as capabilities,
	grove_external_identities as identities,
	grove_agent_access as access,
};
