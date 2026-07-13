ALTER TABLE mls_messages
    ADD COLUMN quarantined_at TIMESTAMPTZ,
    ADD COLUMN quarantine_reason TEXT;

CREATE INDEX mls_messages_pending_recipient
    ON mls_messages (recipient_id, created_at, id)
    WHERE NOT processed AND quarantined_at IS NULL;
