-- effect-db:up
create table grove_loop_projects (
  id text primary key,
  title text not null,
  ask text not null,
  current_version_id text not null,
  created_by_actor_id text not null references grove_actors(id),
  created_at timestamptz not null default now()
);
create table grove_loop_tasks (
  id text primary key,
  project_id text not null references grove_loop_projects(id),
  title text not null,
  objective text not null,
  status text not null check (status in ('planned','claimed','submitted','accepted','completed')),
  version_id text not null,
  depends_on_task_id text references grove_loop_tasks(id),
  created_at timestamptz not null default now()
);
create table grove_loop_attempts (
  id text primary key,
  task_id text not null references grove_loop_tasks(id),
  executor_actor_id text not null references grove_actors(id),
  fence text not null unique,
  status text not null check (status in ('running','submitted','accepted','rejected')),
  artifact_id text unique,
  artifact_version_id text,
  created_at timestamptz not null default now()
);
create table grove_loop_artifacts (
  id text primary key,
  version_id text not null,
  title text not null,
  content text not null,
  digest text not null,
  created_by_actor_id text not null references grove_actors(id),
  created_at timestamptz not null default now()
);
create table grove_loop_reviews (
  id text primary key,
  version_id text not null,
  attempt_id text not null unique references grove_loop_attempts(id),
  reviewer_actor_id text not null references grove_actors(id),
  outcome text not null check (outcome in ('accepted','rejected')),
  comments text,
  created_at timestamptz not null default now()
);
create table grove_loop_completions (
  task_id text primary key references grove_loop_tasks(id),
  completion_version_id text not null,
  attempt_id text not null references grove_loop_attempts(id),
  artifact_id text not null references grove_loop_artifacts(id),
  artifact_version_id text not null,
  review_id text not null references grove_loop_reviews(id),
  review_version_id text not null,
  completed_by_actor_id text not null references grove_actors(id),
  created_at timestamptz not null default now()
);
-- effect-db:down
drop table grove_loop_completions;
drop table grove_loop_reviews;
drop table grove_loop_artifacts;
drop table grove_loop_attempts;
drop table grove_loop_tasks;
drop table grove_loop_projects;
