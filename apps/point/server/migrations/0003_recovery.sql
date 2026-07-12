-- Zero-knowledge account recovery (M4).
--
-- One encrypted MLS-state backup per user. `blob` is produced entirely on the
-- device (point_core::recovery): MAGIC ‖ salt ‖ nonce ‖ XChaCha20-Poly1305(state),
-- keyed by an Argon2id derivation of a recovery code the server NEVER sees. The
-- server stores and returns opaque bytes — it cannot decrypt this, by design.
CREATE TABLE mls_backups (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blob       BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
