-- Task 726: peer re-registration must re-key existing DM MLS groups.
-- `rekeyed_at` marks when a user's MLS identity last changed (key-package
-- pool REPLACED — recovery restore, reinstall, new device). Clients compare
-- it against the time they formed their pairwise group with that peer; newer
-- rekeyed_at ⇒ the group is keyed to a dead identity and must be rebuilt.
-- Backfill from each user's newest existing KeyPackage. This preserves the
-- relative identity generations already visible in a pre-v1.2.2 database, so
-- the older peer is selected as initiator and consumes the re-registered
-- peer's fresh package. Falling back to the account timestamp still forces a
-- one-time rebuild for legacy accounts without a package pool.
ALTER TABLE users ADD COLUMN rekeyed_at timestamptz;

UPDATE users
SET rekeyed_at = COALESCE(
    (SELECT MAX(key_packages.created_at)
     FROM key_packages
     WHERE key_packages.user_id = users.id),
    users.updated_at,
    users.created_at,
    now()
);

ALTER TABLE users ALTER COLUMN rekeyed_at SET DEFAULT now();
ALTER TABLE users ALTER COLUMN rekeyed_at SET NOT NULL;
