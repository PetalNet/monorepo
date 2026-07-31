-- effect-db:up
alter table grove_project_tasks rename to grove_tasks;
alter table grove_tasks drop constraint grove_project_tasks_role_check;
alter table grove_tasks drop constraint grove_project_tasks_status_check;
update grove_tasks set status = 'planning' where role = 'project' and status = 'open';
alter table grove_tasks alter column role drop default;
alter table grove_tasks alter column status set default 'planning';
alter table grove_tasks add constraint grove_tasks_role_check check (role in ('project', 'work'));
alter table grove_tasks add constraint grove_tasks_status_check
  check (status in ('planning', 'planned', 'completed'));
alter table grove_tasks add column parent_task_id text references grove_tasks(object_id);

create table grove_task_dependencies (
  task_id text not null references grove_tasks(object_id),
  depends_on_task_id text not null references grove_tasks(object_id),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);
create index grove_task_dependencies_target_idx on grove_task_dependencies(depends_on_task_id);

create table grove_attempts (
  id text primary key,
  task_id text not null references grove_tasks(object_id),
  task_version_id text not null,
  status text not null check (status in ('running', 'result_submitted', 'fenced')),
  executor_id text not null,
  executor_kind text not null check (executor_kind in ('human', 'mcp')),
  started_at timestamptz not null default now(),
  result_submitted_at timestamptz,
  foreign key (task_version_id, task_id) references grove_object_versions(id, object_id),
  unique (id, task_id)
);

create table grove_claims (
  id text primary key,
  task_id text not null references grove_tasks(object_id),
  attempt_id text not null unique,
  fence text not null unique,
  holder_id text not null,
  holder_kind text not null check (holder_kind in ('human', 'mcp')),
  status text not null check (status in ('leased', 'released', 'expired')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  check (expires_at > issued_at),
  foreign key (attempt_id, task_id) references grove_attempts(id, task_id)
);
create unique index grove_claims_one_leased_per_task on grove_claims(task_id) where status = 'leased';

create table grove_attempt_outputs (
  attempt_id text not null,
  task_id text not null references grove_tasks(object_id),
  object_id text not null references grove_objects(id),
  version_id text not null,
  primary key (attempt_id),
  unique (object_id),
  foreign key (version_id, object_id) references grove_object_versions(id, object_id),
  foreign key (attempt_id, task_id) references grove_attempts(id, task_id)
);

alter table grove_command_receipts add column response jsonb;
update grove_command_receipts set response = jsonb_build_object(
  'commandId', command_id::text, 'objectId', object_id, 'versionId', version_id,
  'versionDigest', version_digest, 'replayed', false
);
alter table grove_command_receipts alter column response set not null;
alter table grove_command_receipts alter column object_id drop not null;
alter table grove_command_receipts alter column version_id drop not null;
alter table grove_command_receipts alter column version_digest drop not null;

alter table grove_outbox drop constraint grove_outbox_command_id_key;
alter table grove_outbox drop constraint grove_outbox_command_id_version_id_aggregate_id_fkey;
create index grove_outbox_command_idx on grove_outbox(command_id);
alter table grove_outbox add constraint grove_outbox_command_id_fkey
  foreign key(command_id) references grove_command_receipts(command_id) deferrable initially deferred;
alter table grove_outbox add constraint grove_outbox_aggregate_version_fkey
  foreign key(version_id, aggregate_id) references grove_object_versions(id, object_id);

-- effect-db:down
-- 0003 cannot represent the execution domain or multiple events per command. Remove it
-- deterministically before restoring the narrower 0003 constraints.
delete from grove_attempt_outputs;
delete from grove_claims;
delete from grove_attempts;
delete from grove_task_dependencies;
delete from grove_outbox where event_type <> 'project.created';
delete from grove_command_receipts where operation <> 'project.create';
delete from grove_tasks where role <> 'project';
update grove_objects set current_version_id=null where not exists (select 1 from grove_tasks t where t.object_id=grove_objects.id);
alter table grove_object_versions disable trigger grove_object_versions_append_only;
delete from grove_object_versions v where not exists (select 1 from grove_tasks t where t.object_id=v.object_id);
delete from grove_objects o where not exists (select 1 from grove_tasks t where t.object_id=o.id);
alter table grove_object_versions enable trigger grove_object_versions_append_only;
drop index grove_outbox_command_idx;
alter table grove_outbox drop constraint grove_outbox_command_id_fkey;
alter table grove_outbox drop constraint grove_outbox_aggregate_version_fkey;
alter table grove_outbox add constraint grove_outbox_command_id_key unique(command_id);
alter table grove_outbox add constraint grove_outbox_command_id_version_id_aggregate_id_fkey
  foreign key(command_id, version_id, aggregate_id)
  references grove_command_receipts(command_id, version_id, object_id) deferrable initially deferred;
alter table grove_command_receipts drop column response;
drop table grove_attempt_outputs;
drop table grove_claims;
drop table grove_attempts;
drop table grove_task_dependencies;
alter table grove_tasks drop column parent_task_id;
alter table grove_tasks drop constraint grove_tasks_role_check;
alter table grove_tasks drop constraint grove_tasks_status_check;
update grove_tasks set status = 'open' where role = 'project';
alter table grove_tasks rename to grove_project_tasks;
alter table grove_project_tasks alter column role set default 'project';
alter table grove_project_tasks alter column status set default 'open';
alter table grove_project_tasks add constraint grove_project_tasks_role_check check(role = 'project');
alter table grove_project_tasks add constraint grove_project_tasks_status_check check(status = 'open');
