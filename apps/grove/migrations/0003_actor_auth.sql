-- effect-db:up
create table "grove_actors" (
  "id" text primary key,
  "kind" text not null check ("kind" in ('person', 'agent')),
  "name" text not null check (length("name") between 1 and 80),
  "lifecycle" text not null default 'active' check ("lifecycle" in ('active', 'dormant', 'suspended', 'retired')),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create table "grove_persons" (
  "actor_id" text primary key references "grove_actors" ("id") on delete restrict,
  "better_auth_user_id" text not null unique
);

create table "grove_external_identities" (
  "actor_id" text not null references "grove_actors" ("id") on delete restrict,
  "issuer" text not null,
  "subject" text not null,
  "use" text not null check ("use" in ('browser', 'machine')),
  "created_at" timestamptz not null default now(),
  primary key ("actor_id", "issuer", "subject"),
  unique ("issuer", "subject")
);

create table "grove_hosts" (
  "id" text primary key,
  "runner_id" text not null unique,
  "owner_person_id" text references "grove_persons" ("actor_id") on delete restrict,
  "created_at" timestamptz not null default now()
);

insert into "grove_hosts" ("id", "runner_id") values ('host-local', 'runner-local');

create table "grove_agents" (
  "actor_id" text primary key references "grove_actors" ("id") on delete restrict,
  "home_host_id" text not null references "grove_hosts" ("id") on delete restrict,
  "owner_person_id" text not null references "grove_persons" ("actor_id") on delete restrict,
  "acting_runtime_id" text unique
);

create table "grove_actor_capabilities" (
  "actor_id" text not null references "grove_actors" ("id") on delete restrict,
  "capability" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("actor_id", "capability")
);

create table "grove_agent_access" (
  "agent_id" text not null references "grove_agents" ("actor_id") on delete restrict,
  "person_id" text not null references "grove_persons" ("actor_id") on delete restrict,
  "valid" boolean not null default true,
  "invalid_reason" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("agent_id", "person_id"),
  check (("valid" and "invalid_reason" is null) or (not "valid" and "invalid_reason" is not null))
);

alter table "grove_demo_sprouts"
  add column "created_by_actor_id" text references "grove_actors" ("id") on delete restrict,
  add column "last_actor_id" text references "grove_actors" ("id") on delete restrict;

create index "grove_external_identities_actor_idx" on "grove_external_identities" ("actor_id");
create index "grove_agents_owner_idx" on "grove_agents" ("owner_person_id");
create index "grove_agent_access_person_idx" on "grove_agent_access" ("person_id") where "valid";

-- effect-db:down
alter table "grove_demo_sprouts" drop column "last_actor_id", drop column "created_by_actor_id";
drop table "grove_agent_access";
drop table "grove_actor_capabilities";
drop table "grove_agents";
drop table "grove_hosts";
drop table "grove_external_identities";
drop table "grove_persons";
drop table "grove_actors";
