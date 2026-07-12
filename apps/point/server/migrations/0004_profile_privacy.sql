-- Wave B (Me/Settings tab): who-can-add-me privacy + profile avatar.
--
-- who_can_add_me gates INBOUND share requests at creation time:
--   anyone       (default) any user with the exact handle may ask
--   same_server  only users on this instance may ask (federated asks dropped)
--   nobody       no inbound asks; the account holder initiates every share
-- Enforcement is silent-drop, matching the endpoint's anti-enumeration
-- design (a blocked requester sees the same generic ok as a nonexistent
-- target, so the setting itself cannot be probed).
--
-- The avatar is the "photo-dot": one small square image per user, stored
-- inline (<=128 KiB enforced in the handler) and served only to accounts
-- with a live relationship (see authz::can_view_profile).

ALTER TABLE users
    ADD COLUMN who_can_add_me TEXT NOT NULL DEFAULT 'anyone'
        CHECK (who_can_add_me IN ('anyone', 'same_server', 'nobody')),
    ADD COLUMN avatar BYTEA,
    ADD COLUMN avatar_mime TEXT;
