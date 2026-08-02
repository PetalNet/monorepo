-- effect-db:up
create table "public"."grove_demo_sprouts" ("id" int8 generated always as identity not null, "name" text not null, "planted_at" timestamptz default now () not null, "waterings" int default 0 not null, primary key ("id"), constraint "grove_demo_sprouts_waterings_nonnegative" check (waterings >= (0)));
insert into "public"."grove_demo_sprouts" ("name") values ('Example fern');
-- effect-db:down
drop table "public"."grove_demo_sprouts";
