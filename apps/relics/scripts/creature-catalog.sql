-- Initial settings for the imported production catalogue, applied once at deployment.
-- IDs are catalogue data. New types remain photo-only until a maker chooses a model.
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS RelicPresentationMigration(id TEXT PRIMARY KEY);
UPDATE RelicType SET modelId='shroomling' WHERE id=1 AND modelId IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
UPDATE RelicType SET modelId='snail' WHERE id=2 AND modelId IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
UPDATE RelicVariety SET color='#bf493e' WHERE id=1 AND typeId=1 AND color IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
UPDATE RelicVariety SET color='#d67a34' WHERE id=2 AND typeId=1 AND color IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
UPDATE RelicVariety SET color='#d78c9d' WHERE id=3 AND typeId=1 AND color IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
UPDATE RelicVariety SET color='#526b47' WHERE id=4 AND typeId=2 AND color IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
UPDATE RelicVariety SET color='#d9a1ad' WHERE id=5 AND typeId=2 AND color IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
UPDATE RelicVariety SET color='#cf4778' WHERE id=6 AND typeId=2 AND color IS NULL AND NOT EXISTS (SELECT 1 FROM RelicPresentationMigration WHERE id='creatures-20261122');
INSERT OR IGNORE INTO RelicPresentationMigration VALUES ('creatures-20261122');
COMMIT;
