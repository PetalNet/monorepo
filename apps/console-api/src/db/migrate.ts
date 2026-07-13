// The ordered security migration (contract §3, PHASE1-DESIGN §3). ONE ordered path, no window:
// roles → tables → RLS enable+force + policy → RO role REVOKE then GRANT SELECT → security_invoker
// views. Idempotent (guarded CREATEs) so it is safe to run at every boot and in tests.
//
// Runs as the admin/owner role. The runtime then connects as console_app / console_ro.

import type { Sql } from "./pool.ts";

// N1a keeps `events` a plain Postgres table so id-dedup is a clean global `ON CONFLICT (id)`.
// The TimescaleDB hypertable conversion + continuous aggregates + retention policies land in
// N1d alongside lake.disk.watermark (a hypertable's unique index must include the partition
// column, which fights global id-uniqueness — so the conversion belongs with the retention work,
// via an emission_ids dedup gate). The extension is created here so N1d only adds the conversion.
const STATEMENTS: readonly string[] = [
	`create extension if not exists timescaledb cascade`,

	// --- runtime roles (cluster-global; all NOSUPERUSER NOBYPASSRLS so RLS actually binds) -----
	//   console_app    — caller-scoped reads (RLS filters to app.scopes)
	//   console_ro     — read-only SQL mode
	//   console_writer — the appender: inserts any scope + sees all rows (for dedup), NOT superuser
	`do $$ begin
	   if not exists (select 1 from pg_roles where rolname = 'console_app') then
	     create role console_app nologin nosuperuser nobypassrls;
	   end if;
	   if not exists (select 1 from pg_roles where rolname = 'console_ro') then
	     create role console_ro nologin nosuperuser nobypassrls;
	   end if;
	   if not exists (select 1 from pg_roles where rolname = 'console_writer') then
	     create role console_writer nologin nosuperuser nobypassrls;
	   end if;
	 end $$`,

	// --- events: the lake. seq is commit-ordered by the serialized appender. ------------------
	`create table if not exists events (
	   seq            bigint generated always as identity primary key,
	   id             uuid not null unique,
	   type           text not null,
	   ts             timestamptz not null,
	   received_at    timestamptz not null default now(),
	   source_service text not null,
	   source_host    text,
	   source_agent   text,
	   subject        text not null,
	   subject_kind   text,
	   severity       text not null,
	   action         text,
	   task_id        bigint,
	   scope          text not null,
	   dimensions     jsonb not null default '{}'::jsonb,
	   measures       jsonb not null default '{}'::jsonb,
	   links          jsonb not null default '[]'::jsonb,
	   body_ref       text,
	   meta           jsonb not null default '{}'::jsonb
	 )`,
	`create index if not exists events_type_received_idx on events (type, received_at desc)`,
	`create index if not exists events_subject_idx on events (subject)`,
	`create index if not exists events_scope_idx on events (scope)`,

	// edges materialized from links at ingest (graphing design §04): "why?" is a graph walk.
	`create table if not exists edges (
	   id        bigint generated always as identity primary key,
	   from_kind text not null,
	   from_id   text not null,
	   rel       text not null,
	   to_kind   text not null,
	   to_id     text not null,
	   scope     text not null,
	   seq       bigint not null references events(seq)
	 )`,
	`create index if not exists edges_from_idx on edges (from_kind, from_id)`,
	`create index if not exists edges_to_idx on edges (to_kind, to_id)`,

	// blobs: body_ref payloads, scope-checked on fetch by the same RLS as events.
	`create table if not exists blobs (
	   id         text primary key,
	   scope      text not null,
	   bytes      bytea not null,
	   created_at timestamptz not null default now()
	 )`,

	// semantic registry: auto-registered statistic types (L2 input).
	`create table if not exists semantic_registry (
	   type        text primary key,
	   first_seen  timestamptz not null default now(),
	   last_emit   timestamptz,
	   dimensions  jsonb not null default '{}'::jsonb,
	   measures    jsonb not null default '{}'::jsonb,
	   scopes      jsonb not null default '[]'::jsonb,
	   emit_count  bigint not null default 0
	 )`,

	// producer registrations: the emit-authz allow-lists (contract §4.3), seeded out of band.
	`create table if not exists producer_registrations (
	   subject          text primary key,
	   allowed_services jsonb not null default '[]'::jsonb,
	   allowed_prefixes jsonb not null default '[]'::jsonb,
	   allowed_scopes   jsonb not null default '[]'::jsonb,
	   max_severity     text not null default 'info'
	 )`,

	// bearer verification (sha256 only; the vault keeps plaintext for re-issue, CP4).
	`create table if not exists api_tokens (
	   token_sha256 text primary key,
	   subject      text not null,
	   kind         text not null,
	   tiers        jsonb not null default '[]'::jsonb,
	   lanes        jsonb not null default '[]'::jsonb,
	   created_at   timestamptz not null default now(),
	   revoked_at   timestamptz
	 )`,

	// ReBAC grants (contract §7.2).
	`create table if not exists grants (
	   id         bigint generated always as identity primary key,
	   subject    text not null,
	   relation   text not null,
	   object     text not null,
	   condition  text,
	   valid_at   timestamptz not null default now(),
	   invalid_at timestamptz,
	   granted_by text not null,
	   zookie     bigint not null default 1
	 )`,
	`create index if not exists grants_subject_idx on grants (subject)`,

	`create table if not exists tiers (
	   name            text primary key,
	   authentik_group text,
	   propose_only    boolean not null default false
	 )`,

	// --- N1b: current-state projection (latest per entity), keyed by the PROJECTION bucket -----
	// kind is the projection-map target (fleet|heartbeat|registry|governance|card|worker|
	// box_update|edge), NOT the emission subject_kind (which is `agent` for four of them).
	`create table if not exists current_state (
	   kind              text not null,
	   subject           text not null,
	   scope             text not null,
	   state             jsonb not null,
	   observed_at       timestamptz not null,
	   producer_ts       timestamptz,
	   unreachable_since timestamptz,
	   seq               bigint not null,
	   primary key (kind, subject)
	 )`,

	// projector durability: the seq up to which current_state reflects the lake.
	`create table if not exists projection_checkpoint (
	   name         text primary key,
	   through_seq  bigint not null default 0,
	   updated_at   timestamptz not null default now()
	 )`,

	// bridge cursors: the high-water mark a co-located bridge has ingested per source (durable so a
	// restart resumes; deterministic emission ids make re-processing safe regardless).
	`create table if not exists bridge_cursor (
	   source      text primary key,
	   cursor      text not null default '',
	   below_count integer not null default 0,
	   updated_at  timestamptz not null default now()
	 )`,

	// executor signing keys: completions are executor-SIGNED, verified here; the bridge is relay-only.
	`create table if not exists executor_keys (
	   executor    text primary key,
	   algorithm   text not null default 'ed25519',
	   public_key  text not null,
	   created_at  timestamptz not null default now(),
	   revoked_at  timestamptz
	 )`,

	// minimal Library items table (dashboards/artifacts projection) — Phase-1 wire surface.
	`create table if not exists items_min (
	   id                 text primary key,
	   kind               text not null,
	   title              text not null,
	   scope              text not null,
	   is_home            boolean not null default false,
	   created_by         text,
	   responsible_human  text,
	   payload            jsonb not null default '{}'::jsonb,
	   updated_at         timestamptz not null default now()
	 )`,

	// --- RLS: enable + force on every scoped base table, then the policy ----------------------
	`alter table current_state enable row level security`,
	`alter table current_state force row level security`,
	`alter table items_min enable row level security`,
	`alter table items_min force row level security`,
	`alter table events enable row level security`,
	`alter table events force row level security`,
	`alter table edges enable row level security`,
	`alter table edges force row level security`,
	`alter table blobs enable row level security`,
	`alter table blobs force row level security`,

	// SELECT policy: a caller sees a row iff its scope is in the per-transaction app.scopes GUC.
	// Unset GUC → string_to_array(NULL,',') → NULL → scope = ANY(NULL) → NULL → row excluded
	// (fail-closed). console_writer (the appender) sees ALL rows so dedup can find any id, and may
	// INSERT any scope — scope authorization already happened at the emit door; the durable scope
	// tag is what caller reads filter on.
	`do $$ begin
	   if not exists (select 1 from pg_policies where tablename='events' and policyname='events_scope_select') then
	     create policy events_scope_select on events for select to console_app, console_ro
	       using (scope = any (string_to_array(current_setting('app.scopes', true), ',')));
	   end if;
	   if not exists (select 1 from pg_policies where tablename='events' and policyname='events_writer_all') then
	     create policy events_writer_all on events to console_writer using (true) with check (true);
	   end if;
	   if not exists (select 1 from pg_policies where tablename='edges' and policyname='edges_scope_select') then
	     create policy edges_scope_select on edges for select to console_app, console_ro
	       using (scope = any (string_to_array(current_setting('app.scopes', true), ',')));
	   end if;
	   if not exists (select 1 from pg_policies where tablename='edges' and policyname='edges_writer_all') then
	     create policy edges_writer_all on edges to console_writer using (true) with check (true);
	   end if;
	   if not exists (select 1 from pg_policies where tablename='blobs' and policyname='blobs_scope_select') then
	     create policy blobs_scope_select on blobs for select to console_app, console_ro
	       using (scope = any (string_to_array(current_setting('app.scopes', true), ',')));
	   end if;
	   if not exists (select 1 from pg_policies where tablename='blobs' and policyname='blobs_writer_all') then
	     create policy blobs_writer_all on blobs to console_writer using (true) with check (true);
	   end if;
	   if not exists (select 1 from pg_policies where tablename='current_state' and policyname='current_state_scope_select') then
	     create policy current_state_scope_select on current_state for select to console_app, console_ro
	       using (scope = any (string_to_array(current_setting('app.scopes', true), ',')));
	   end if;
	   if not exists (select 1 from pg_policies where tablename='current_state' and policyname='current_state_writer_all') then
	     create policy current_state_writer_all on current_state to console_writer using (true) with check (true);
	   end if;
	   if not exists (select 1 from pg_policies where tablename='items_min' and policyname='items_min_scope_select') then
	     create policy items_min_scope_select on items_min for select to console_app, console_ro
	       using (scope = any (string_to_array(current_setting('app.scopes', true), ',')));
	   end if;
	   if not exists (select 1 from pg_policies where tablename='items_min' and policyname='items_min_writer_all') then
	     create policy items_min_writer_all on items_min to console_writer using (true) with check (true);
	   end if;
	 end $$`,

	// --- grants -------------------------------------------------------------------------------
	`revoke all on all tables in schema public from console_ro`,
	`grant usage on schema public to console_app, console_ro, console_writer`,
	`grant select on events, current_state, items_min to console_ro`,
	// console_app: scoped reads across the read surface.
	`grant select on events, edges, blobs, current_state, items_min, semantic_registry, grants, producer_registrations, tiers, api_tokens, executor_keys to console_app`,
	`grant insert, update, select on semantic_registry to console_app, console_writer`,
	// console_writer: the appender + projector (non-superuser) — insert events/edges/blobs, upsert current_state.
	`grant insert, select on events, edges, blobs to console_writer`,
	`grant insert, update, select, delete on current_state, items_min to console_writer`,
	`grant insert, update, select on projection_checkpoint to console_writer`,
	`grant insert, update, select on bridge_cursor to console_writer`,
];

export interface MigrateOpts {
	/**
	 * When set, grant LOGIN + this password to console_app (dev/test convenience; prod uses a managed
	 * role).
	 */
	readonly appPassword?: string;
	readonly roPassword?: string;
	readonly writerPassword?: string;
}

export async function migrate(admin: Sql, opts?: MigrateOpts): Promise<void> {
	for (const stmt of STATEMENTS) {
		await admin.unsafe(stmt);
	}
	if (opts?.appPassword)
		await admin.unsafe(
			`alter role console_app login password '${opts.appPassword.replace(/'/g, "''")}'`,
		);
	if (opts?.roPassword)
		await admin.unsafe(
			`alter role console_ro login password '${opts.roPassword.replace(/'/g, "''")}'`,
		);
	if (opts?.writerPassword)
		await admin.unsafe(
			`alter role console_writer login password '${opts.writerPassword.replace(/'/g, "''")}'`,
		);
}
