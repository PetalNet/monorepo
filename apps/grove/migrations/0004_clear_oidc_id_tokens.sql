-- effect-db:up
update "account" set "idToken" = null where "idToken" is not null;

-- effect-db:down
-- Verified ID tokens are intentionally not recoverable after removal.
select 1;
