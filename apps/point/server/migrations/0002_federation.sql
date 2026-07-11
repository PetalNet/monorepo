-- 0002_federation.sql — M3 cross-instance E2E location sharing (signed S2S).
--
-- Design notes (see DECISIONS.md D-005/D-007, docs/legacy/server-map.md §5/§6):
--   * Each instance owns one Ed25519 signing keypair, generated on first boot and
--     persisted here (single row). The PUBLIC key is published via
--     `GET /.well-known/point`; peers verify our outbound S2S signatures with it.
--     The private key never leaves this table and is never logged.
--   * TOFU-pin: the first time a local user is contacted by a given remote user we
--     pin a hash of the remote's MLS identity/credential key. A later contact whose
--     key hash differs is REJECTED (a forced-re-verify signal), fail-closed.

-- ---------------------------------------------------------------------------
-- This instance's Ed25519 signing keypair (single row, id = 1).
-- ---------------------------------------------------------------------------
CREATE TABLE server_keys (
    id          SMALLINT PRIMARY KEY DEFAULT 1,
    private_key BYTEA NOT NULL,               -- 32-byte Ed25519 seed (secret; never logged)
    public_key  BYTEA NOT NULL,               -- 32-byte Ed25519 verifying key (published as hex)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- TOFU identity pins: (local user, remote user) -> pinned remote identity key.
-- A changed key on a later contact is a loud, fail-closed reject (forced
-- re-verify). `verified` is set out-of-band (SAS/QR) via /api/federation/verify.
-- ---------------------------------------------------------------------------
CREATE TABLE federation_pins (
    local_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    remote_user_id TEXT NOT NULL,             -- full 'name@domain' of the remote user
    key_hash       TEXT NOT NULL,             -- hex SHA-256 of the remote's identity key
    verified       BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (local_user_id, remote_user_id)
);
