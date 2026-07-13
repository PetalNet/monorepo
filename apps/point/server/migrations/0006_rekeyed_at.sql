-- Task 726: peer re-registration must re-key existing DM MLS groups.
-- `rekeyed_at` marks when a user's MLS identity last changed (key-package
-- pool REPLACED — recovery restore, reinstall, new device). Clients compare
-- it against the time they formed their pairwise group with that peer; newer
-- rekeyed_at ⇒ the group is keyed to a dead identity and must be rebuilt.
-- Backfill to now(): every existing pair rebuilds once on first v1.2.2 run,
-- which also heals any already-wedged group without a manual re-share.
ALTER TABLE users ADD COLUMN rekeyed_at timestamptz NOT NULL DEFAULT now();
