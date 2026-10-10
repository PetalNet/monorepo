-- effect-db:up
drop table grove_demo_sprouts;
delete from grove_actor_capabilities where capability in
  ('sprouts.list', 'sprouts.get', 'sprouts.create', 'sprouts.water', 'sprouts.remove');

-- effect-db:down
-- Rollback restores the demo schema and grants, not discarded demo data.
create table grove_demo_sprouts (
  id int8 generated always as identity primary key,
  name text not null,
  planted_at timestamptz default now() not null,
  waterings int default 0 not null,
  created_by_actor_id text references grove_actors(id) on delete restrict,
  last_actor_id text references grove_actors(id) on delete restrict,
  constraint grove_demo_sprouts_waterings_nonnegative check (waterings >= 0)
);
insert into grove_actor_capabilities (actor_id, capability)
select actors.id, legacy.capability from grove_actors actors cross join
  (values ('sprouts.list'), ('sprouts.get'), ('sprouts.create'), ('sprouts.water'), ('sprouts.remove')) legacy(capability)
on conflict do nothing;
