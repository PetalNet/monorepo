create table "user" (
  "id" text primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "authentikUsername" text not null,
  "authentikGroups" text not null,
  "authentikSubject" text not null unique
);

create table "session" (
  "id" text primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "token" text not null unique,
  "expiresAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table "account" (
  "id" text primary key,
  "userId" text not null references "user" ("id") on delete cascade,
  "accountId" text not null,
  "providerId" text not null,
  "accessToken" text,
  "refreshToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "idToken" text,
  "password" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table "verification" (
  "id" text primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table "tier" (
  "id" text primary key,
  "name" text not null unique,
  "description" text not null,
  "proposeOnly" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table "principal" (
  "id" text primary key,
  "kind" text not null check ("kind" in ('human', 'agent', 'system')),
  "userId" text unique references "user" ("id") on delete cascade,
  "oidcSubject" text unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table "principalTier" (
  "principalId" text not null references "principal" ("id") on delete cascade,
  "tierId" text not null references "tier" ("id") on delete cascade,
  "source" text not null check ("source" in ('authentik', 'better-auth')),
  "createdAt" timestamptz not null default now(),
  primary key ("principalId", "tierId")
);

create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");

insert into "tier" ("id", "name", "description") values
  ('owner', 'owner', 'Full console ownership'),
  ('operator', 'operator', 'Operational access'),
  ('editor', 'editor', 'Editing access'),
  ('viewer', 'viewer', 'Read-only access');
