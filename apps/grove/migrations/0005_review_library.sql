-- effect-db:up
alter table grove_attempts drop constraint grove_attempts_status_check;
alter table grove_attempts add constraint grove_attempts_status_check
  check (status in ('running', 'result_submitted', 'review_rejected', 'accepted', 'fenced'));
create unique index grove_attempts_one_accepted_per_task
  on grove_attempts(task_id) where status = 'accepted';

create function grove_validate_attempt_update() returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.task_id <> old.task_id
     or new.task_version_id <> old.task_version_id
     or new.executor_id <> old.executor_id or new.executor_kind <> old.executor_kind
     or new.started_at <> old.started_at then
    raise exception 'Attempt identity and provenance are immutable';
  end if;
  if new.status <> old.status and not (
    (old.status = 'running' and new.status in ('result_submitted', 'fenced'))
    or (old.status = 'result_submitted' and new.status in ('accepted', 'review_rejected'))
  ) then
    raise exception 'invalid Attempt status transition from % to %', old.status, new.status;
  end if;
  if new.result_submitted_at is distinct from old.result_submitted_at and not (
    old.result_submitted_at is null and new.result_submitted_at is not null
    and old.status = 'running' and new.status = 'result_submitted'
  ) then
    raise exception 'Attempt submission time is immutable';
  end if;
  return new;
end $$;
create trigger grove_attempts_validate_update before update on grove_attempts
for each row execute function grove_validate_attempt_update();

alter table grove_attempt_outputs add constraint grove_attempt_outputs_review_target_key
  unique (attempt_id, task_id, object_id, version_id);
alter table grove_attempts add constraint grove_attempts_completion_target_key
  unique (id, task_id, task_version_id);

create table grove_reviews (
  object_id text primary key references grove_objects(id),
  version_id text not null,
  reviewer_id text not null,
  reviewer_kind text not null check (reviewer_kind in ('human', 'mcp')),
  subject_object_id text not null,
  subject_version_id text not null,
  attempt_id text not null,
  task_id text not null,
  outcome text not null check (outcome in ('accepted', 'rejected')),
  comments text check (comments is null or (length(comments) between 1 and 4000)),
  foreign key (version_id, object_id) references grove_object_versions(id, object_id),
  foreign key (subject_version_id, subject_object_id) references grove_object_versions(id, object_id),
  foreign key (attempt_id, task_id) references grove_attempts(id, task_id),
  foreign key (attempt_id, task_id, subject_object_id, subject_version_id)
    references grove_attempt_outputs(attempt_id, task_id, object_id, version_id),
  unique (attempt_id)
);
alter table grove_reviews add constraint grove_reviews_completion_target_key
  unique (object_id, version_id, attempt_id, task_id, subject_object_id, subject_version_id, outcome);

-- Metadata integrity which needs Version authorship is deliberately enforced in the database.
create function grove_validate_review() returns trigger language plpgsql as $$
declare
  author_id text;
  author_kind text;
  executor_id text;
  executor_kind text;
  object_kind text;
  review_author_id text;
  review_author_kind text;
  review_object_kind text;
  review_payload jsonb;
  expected_payload jsonb;
begin
  select v.actor_id,v.actor_kind,o.kind into author_id,author_kind,object_kind
  from grove_object_versions v join grove_objects o on o.id=v.object_id
  where v.id=new.subject_version_id and v.object_id=new.subject_object_id;
  if object_kind <> 'artifact' then raise exception 'review subject must be an artifact'; end if;
  select a.executor_id,a.executor_kind into executor_id,executor_kind
  from grove_attempts a where a.id=new.attempt_id and a.task_id=new.task_id;
  select v.actor_id,v.actor_kind,o.kind,v.payload
    into review_author_id,review_author_kind,review_object_kind,review_payload
  from grove_object_versions v join grove_objects o on o.id=v.object_id
  where v.id=new.version_id and v.object_id=new.object_id;
  if review_object_kind <> 'review' then raise exception 'review metadata must belong to a review object'; end if;
  if review_author_id <> new.reviewer_id or review_author_kind <> new.reviewer_kind then
    raise exception 'review Version author must match reviewer';
  end if;
  expected_payload := jsonb_build_object(
    'type','review', 'reviewer',jsonb_build_object('id',new.reviewer_id,'kind',new.reviewer_kind),
    'taskId',new.task_id, 'attemptId',new.attempt_id,
    'subject',jsonb_build_object('objectId',new.subject_object_id,'versionId',new.subject_version_id),
    'outcome',new.outcome
  );
  if new.comments is not null then
    expected_payload := expected_payload || jsonb_build_object('comments',new.comments);
  end if;
  if review_payload is distinct from expected_payload then
    raise exception 'review Version payload must exactly match review metadata';
  end if;
  if (author_id=new.reviewer_id and author_kind=new.reviewer_kind)
     or (executor_id=new.reviewer_id and executor_kind=new.reviewer_kind) then
    raise exception 'artifact authors and attempt executors cannot review their own output';
  end if;
  return new;
end $$;
create trigger grove_reviews_validate before insert on grove_reviews
for each row execute function grove_validate_review();
create trigger grove_reviews_immutable before update or delete on grove_reviews
for each row execute function grove_reject_version_mutation();
create trigger grove_reviews_reject_truncate before truncate on grove_reviews
for each statement execute function grove_reject_version_mutation();
create trigger grove_attempt_outputs_immutable before update or delete on grove_attempt_outputs
for each row execute function grove_reject_version_mutation();
create trigger grove_attempt_outputs_reject_truncate before truncate on grove_attempt_outputs
for each statement execute function grove_reject_version_mutation();

create table grove_task_completions (
  completion_version_id text primary key,
  task_id text not null,
  task_version_id text not null,
  attempt_id text not null,
  output_object_id text not null,
  output_version_id text not null,
  review_object_id text not null,
  review_version_id text not null,
  outcome text not null default 'accepted' check (outcome = 'accepted'),
  foreign key (completion_version_id, task_id) references grove_object_versions(id, object_id),
  foreign key (attempt_id, task_id, task_version_id) references grove_attempts(id, task_id, task_version_id),
  foreign key (attempt_id, task_id, output_object_id, output_version_id)
    references grove_attempt_outputs(attempt_id, task_id, object_id, version_id),
  foreign key (review_object_id, review_version_id, attempt_id, task_id, output_object_id, output_version_id, outcome)
    references grove_reviews(object_id, version_id, attempt_id, task_id, subject_object_id, subject_version_id, outcome),
  unique (task_id)
);
create function grove_validate_task_completion() returns trigger language plpgsql as $$
declare
  completion_payload jsonb;
  completion_parent_id text;
begin
  if not exists (select 1 from grove_attempts where id=new.attempt_id and task_id=new.task_id and status='accepted') then
    raise exception 'completion Attempt must be accepted';
  end if;
  if not exists (select 1 from grove_reviews where object_id=new.review_object_id and version_id=new.review_version_id
    and attempt_id=new.attempt_id and task_id=new.task_id and subject_object_id=new.output_object_id
    and subject_version_id=new.output_version_id and outcome='accepted') then
    raise exception 'completion Review must accept the exact output';
  end if;
  select payload,parent_version_id into completion_payload,completion_parent_id
  from grove_object_versions where id=new.completion_version_id and object_id=new.task_id;
  if completion_parent_id is distinct from new.task_version_id
     or completion_payload->>'status' is distinct from 'completed'
     or completion_payload#>>'{completion,attemptId}' is distinct from new.attempt_id
     or completion_payload#>>'{completion,output,objectId}' is distinct from new.output_object_id
     or completion_payload#>>'{completion,output,versionId}' is distinct from new.output_version_id
     or completion_payload#>>'{completion,review,objectId}' is distinct from new.review_object_id
     or completion_payload#>>'{completion,review,versionId}' is distinct from new.review_version_id then
    raise exception 'completion Version must exactly cite completion metadata';
  end if;
  return new;
end $$;
create trigger grove_task_completions_validate before insert on grove_task_completions
for each row execute function grove_validate_task_completion();
create trigger grove_task_completions_immutable before update or delete on grove_task_completions
for each row execute function grove_reject_version_mutation();
create trigger grove_task_completions_reject_truncate before truncate on grove_task_completions
for each statement execute function grove_reject_version_mutation();

-- effect-db:down
drop trigger grove_task_completions_reject_truncate on grove_task_completions;
drop trigger grove_task_completions_immutable on grove_task_completions;
drop trigger grove_task_completions_validate on grove_task_completions;
drop function grove_validate_task_completion();
drop table grove_task_completions;
drop trigger grove_attempt_outputs_reject_truncate on grove_attempt_outputs;
drop trigger grove_attempt_outputs_immutable on grove_attempt_outputs;
drop trigger grove_reviews_reject_truncate on grove_reviews;
drop trigger grove_reviews_immutable on grove_reviews;
drop trigger grove_reviews_validate on grove_reviews;
drop function grove_validate_review();
drop table grove_reviews;
alter table grove_attempt_outputs drop constraint grove_attempt_outputs_review_target_key;
alter table grove_attempts drop constraint grove_attempts_completion_target_key;
drop trigger grove_attempts_validate_update on grove_attempts;
drop function grove_validate_attempt_update();
drop index grove_attempts_one_accepted_per_task;
update grove_attempts set status = 'result_submitted'
where status in ('accepted', 'review_rejected');
alter table grove_attempts drop constraint grove_attempts_status_check;
alter table grove_attempts add constraint grove_attempts_status_check
  check (status in ('running', 'result_submitted', 'fenced'));
