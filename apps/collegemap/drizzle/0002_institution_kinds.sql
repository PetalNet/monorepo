-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so unlike the CREATE statements in 0000 and 0001 this
-- file is not idempotent, and it does not need to be. Those two had to be no-ops because the
-- production database was built by `drizzle-kit push` before any migration existed. This one is
-- applied by the migrator, which has recorded 0000 and 0001 there already, so it runs exactly once.
--
-- The DEFAULT is what migrates the existing rows: every place in the table today is a college.
ALTER TABLE `colleges` ADD `kind` text DEFAULT 'college' NOT NULL;
