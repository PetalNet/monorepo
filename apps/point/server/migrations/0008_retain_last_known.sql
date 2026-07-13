-- location_updates is a bounded, one-row-per-sender/audience last-known
-- snapshot table. TTL remains as compatibility metadata; freshness is derived
-- by clients from client_timestamp and rows no longer expire server-side.
ALTER TABLE location_updates
    ALTER COLUMN ttl_seconds SET DEFAULT 86400;

UPDATE location_updates
SET ttl_seconds = 86400
WHERE ttl_seconds = 300;
