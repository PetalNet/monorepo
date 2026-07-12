-- Wave D (notification transport): generalize push registration from
-- FCM-only tokens to transport-agnostic endpoints. A user (really, a device)
-- registers exactly one of:
--   unifiedpush  -- an endpoint URL the user's own distributor gave us; the
--                   server POSTs an encrypted wake to it.
--   fcm          -- a Google FCM registration token.
--
-- Multiple rows per user = multiple devices. The old fcm_tokens rows are
-- migrated in as ('fcm', token). The wake payload the server sends carries no
-- who/where; it only says "a Point event is waiting" so the client wakes and
-- pulls over the authenticated channel.

CREATE TABLE push_endpoints (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transport  TEXT NOT NULL CHECK (transport IN ('unifiedpush', 'fcm')),
    -- The UnifiedPush endpoint URL, or the FCM token. Unique per user so a
    -- device re-registering updates in place.
    endpoint   TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, endpoint)
);

CREATE INDEX push_endpoints_user ON push_endpoints (user_id);

-- Carry the existing FCM tokens forward so no one loses push on upgrade.
INSERT INTO push_endpoints (user_id, transport, endpoint, updated_at)
SELECT user_id, 'fcm', token, updated_at FROM fcm_tokens
ON CONFLICT (user_id, endpoint) DO NOTHING;

DROP TABLE fcm_tokens;
