-- effect-db:up
create table grove_objects (
  id text primary key,
  kind text not null,
  scope text not null,
  current_version_id text,
  created_at timestamptz not null default now()
);

create table grove_object_versions (
  id text primary key,
  object_id text not null references grove_objects(id),
  parent_version_id text,
  payload jsonb not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  actor_id text not null,
  actor_kind text not null check (actor_kind in ('human', 'mcp')),
  created_at timestamptz not null default now(),
  unique (id, object_id),
  foreign key (parent_version_id, object_id) references grove_object_versions(id, object_id)
);

alter table grove_objects add constraint grove_objects_current_version_fk
foreign key (current_version_id, id) references grove_object_versions(id, object_id);
create index grove_object_versions_object_created_idx
on grove_object_versions (object_id, created_at, id);
create index grove_object_versions_parent_idx on grove_object_versions (parent_version_id)
where parent_version_id is not null;

create table grove_project_tasks (
  object_id text primary key references grove_objects(id),
  role text not null default 'project' check (role = 'project'),
  status text not null default 'open' check (status in ('open'))
);

create table grove_command_receipts (
  command_id uuid primary key,
  operation text not null,
  principal_id text not null,
  principal_kind text not null check (principal_kind in ('human', 'mcp')),
  input_hash text not null,
  object_id text not null references grove_objects(id),
  version_id text not null,
  version_digest text not null,
  created_at timestamptz not null default now(),
  foreign key (version_id, object_id) references grove_object_versions(id, object_id),
  unique (command_id, version_id, object_id)
);

create table grove_outbox (
  id text primary key,
  command_id uuid not null unique,
  version_id text not null,
  event_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  foreign key (command_id, version_id, aggregate_id)
    references grove_command_receipts(command_id, version_id, object_id) deferrable initially deferred
);

create function grove_reject_version_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'grove object versions are append-only';
end $$;
create trigger grove_object_versions_append_only before update or delete on grove_object_versions
for each row execute function grove_reject_version_mutation();
create trigger grove_object_versions_reject_truncate before truncate on grove_object_versions
for each statement execute function grove_reject_version_mutation();

-- effect-db:down
drop table grove_outbox;
drop table grove_command_receipts;
drop table grove_project_tasks;
alter table grove_objects drop constraint grove_objects_current_version_fk;
drop trigger if exists grove_object_versions_reject_truncate on grove_object_versions;
drop trigger grove_object_versions_append_only on grove_object_versions;
drop function grove_reject_version_mutation();
drop table grove_object_versions;
drop table grove_objects;
