-- 0001_init.sql — Point v1 foundation schema (Postgres).
--
-- Design notes (see DECISIONS.md D-005..D-009 and docs/legacy/server-map.md):
--   * The server stores CIPHERTEXT + routing metadata only. Every location payload
--     is an opaque MLS blob (BYTEA); the server never sees plaintext coordinates.
--   * person + item are first-class via `entities` (decision 7); v1 implements
--     people only. Location rows reference entity_id so trackers slot in at v1.5.
--   * Authz source-of-truth tables: user_shares (bidirectional, canonical order),
--     temporary_shares (directional, TTL), groups + group_members. Delivery is
--     fail-closed and server-enforced, including ghost (global + per-target).
--   * Federated users get shadow rows (is_federated, password_hash NULL).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id                  TEXT PRIMARY KEY,             -- 'alice@example.org'
    display_name        TEXT NOT NULL,
    password_hash       TEXT,                         -- PHC string; NULL = federated shadow or OIDC-only
    is_admin            BOOLEAN NOT NULL DEFAULT FALSE,
    is_federated        BOOLEAN NOT NULL DEFAULT FALSE,
    ghost_active        BOOLEAN NOT NULL DEFAULT FALSE, -- global ghost kill-switch (server-enforced)
    visibility_mode     TEXT NOT NULL DEFAULT 'normal', -- Focus-style modes: schema slot, no v1 surface
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- JWT revocation floor (iat < this => reject)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- person + item first-class; v1 creates exactly one 'person' entity per user.
CREATE TABLE entities (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT NOT NULL CHECK (kind IN ('person', 'item')),
    owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one person-entity per user; items (v1.5) are unconstrained
CREATE UNIQUE INDEX entities_one_person_per_user ON entities (owner_id) WHERE kind = 'person';

-- Devices: multi-device ACCESS is v1 (view from anywhere; broadcast from primary).
-- Enrollment beyond the first device is device-linking (M1); the server can
-- record devices only through an authenticated flow — it never injects them.
CREATE TABLE devices (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen  TIMESTAMPTZ
);
CREATE UNIQUE INDEX devices_one_primary_per_user ON devices (user_id) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- Sharing model (lifted from legacy, enforcement fixed per D-005)
-- ---------------------------------------------------------------------------

CREATE TABLE share_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_user_id, to_user_id)
);

-- Accepted, permanent, bidirectional shares. Canonical ordering: user_a < user_b.
CREATE TABLE user_shares (
    user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);

-- Directional, expiring shares. to_user_id targets a user; link_token supports
-- share-links (schema slot — no v1 route consumes tokens yet, mirrors legacy).
CREATE TABLE temporary_shares (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
    link_token   TEXT UNIQUE,
    precision    TEXT NOT NULL DEFAULT 'exact',
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (to_user_id IS NOT NULL OR link_token IS NOT NULL)
);
CREATE INDEX temporary_shares_to_user ON temporary_shares (to_user_id) WHERE to_user_id IS NOT NULL;
CREATE INDEX temporary_shares_expires ON temporary_shares (expires_at);

CREATE TABLE groups (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT NOT NULL,
    owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    members_can_invite BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
    group_id  UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    -- member's own choice to broadcast into this group; enforced server-side on fan-out
    sharing   BOOLEAN NOT NULL DEFAULT TRUE,
    precision TEXT NOT NULL DEFAULT 'exact',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_by_user ON group_members (user_id);

CREATE TABLE group_invites (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    code       TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_uses   INTEGER NOT NULL DEFAULT 0, -- 0 = unlimited
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-level registration invites (required while OPEN_REGISTRATION=false).
CREATE TABLE invites (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code       TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    max_uses   INTEGER NOT NULL DEFAULT 1,
    uses       INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ghost: global kill-switch lives on users.ghost_active; this is the per-target
-- set (spec §07: "server-enforced kill-switch + per-target set"). v1 UI exposes
-- only the global toggle; enforcement checks both, fail-closed.
CREATE TABLE ghost_targets (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, target_user_id)
);

-- ---------------------------------------------------------------------------
-- MLS delivery service (ciphertext-only)
-- ---------------------------------------------------------------------------

-- One-time-use KeyPackages (D-007). Fetch atomically consumes one unconsumed
-- non-last-resort package; the last-resort package is returned (not consumed)
-- only when the pool is dry.
CREATE TABLE key_packages (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_package    BYTEA NOT NULL,               -- opaque serialized MLS KeyPackage
    is_last_resort BOOLEAN NOT NULL DEFAULT FALSE,
    consumed_at    TIMESTAMPTZ,                  -- NULL = available
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX key_packages_pool ON key_packages (user_id, created_at)
    WHERE consumed_at IS NULL AND NOT is_last_resort;
CREATE UNIQUE INDEX key_packages_one_last_resort ON key_packages (user_id) WHERE is_last_resort;

-- Welcome/Commit relay mailbox (opaque MLS payloads).
CREATE TABLE mls_messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_type TEXT NOT NULL CHECK (message_type IN ('welcome', 'commit')),
    group_id     TEXT NOT NULL,                  -- server-side share/group id (routing only)
    payload      BYTEA NOT NULL,                 -- opaque serialized MLS message
    processed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mls_messages_pending ON mls_messages (recipient_id, processed, created_at);

-- ---------------------------------------------------------------------------
-- Location (ciphertext-only)
-- ---------------------------------------------------------------------------

-- Current/live fixes, one row per (sender entity, audience). TTL-reaped.
CREATE TABLE location_updates (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    recipient_type   TEXT NOT NULL CHECK (recipient_type IN ('user', 'group')),
    recipient_id     TEXT NOT NULL,              -- user id or group uuid-as-text (routing only)
    encrypted_blob   BYTEA NOT NULL,             -- opaque MLS ciphertext
    client_timestamp BIGINT NOT NULL,            -- sender-claimed epoch millis (opaque metadata)
    ttl_seconds      INTEGER NOT NULL DEFAULT 300,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX location_updates_recipient ON location_updates (recipient_type, recipient_id, created_at DESC);
CREATE INDEX location_updates_created ON location_updates (created_at);

-- Encrypted trail, 30-day retention (cleanup task).
CREATE TABLE location_history (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id        UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    recipient_type   TEXT NOT NULL CHECK (recipient_type IN ('user', 'group')),
    recipient_id     TEXT NOT NULL,              -- audience the blob was encrypted for
    encrypted_blob   BYTEA NOT NULL,
    client_timestamp BIGINT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX location_history_by_entity ON location_history (entity_id, client_timestamp DESC);
CREATE INDEX location_history_created ON location_history (created_at);

-- ---------------------------------------------------------------------------
-- Push wake tokens (sender lands in M1, D-012)
-- ---------------------------------------------------------------------------

CREATE TABLE fcm_tokens (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, token)
);
