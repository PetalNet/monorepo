# Petal Relics

Private collections for physical NFC and QR collectibles. A tag opens `/relics/{id}`. Claim with a name, keep the collection on this device, and optionally verify a recovery email. Collectors have no account or PIN. Only admins sign in, through Authentik.

## Develop

From the monorepo root, run `pnpm install`, then `pnpm --filter @petalnet/relics dev`. Copy `.env.example` to `.env` in this directory and configure the variables you need. An empty database starts with an empty catalog. Admins create types, varieties and allocation ranges. No production data or artwork ships in this repository.

Run `pnpm --filter @petalnet/relics check`, `test`, `lint:eslint` and `build` for validation.

The web surface uses Svelte 5, DaisyUI, fontless, and the monorepo’s `effect-api` and `effect-sveltekit`. Schema-defined operations generate REST and OpenAPI at `/api/v1/docs`. MCP is disabled because this app grants access through browser-bound cookies. The domain uses Node’s SQLite driver to preserve the existing SQLite database and schema without an ORM conversion. Legacy bcrypt verification is used only for the one-time move.

## Collections and privacy

A random 256-bit HttpOnly cookie grants access to a collection; only its SHA-256 digest is stored. This is device-bound access to server-held ownership records. Clearing cookies loses access unless the collector verified an email or an admin reassigns the relics. A collection lasts across server restarts. Device grants expire after two years.

Email links expire after 15 minutes, can be used once, and require a button press before being consumed. Opening a link switches this device to that collection. A recovery address is not stored as verified until its link is consumed. Existing legacy email addresses are not treated as verified. Resend handles delivery, configured with `RESEND_API_KEY` and `EMAIL_FROM`. There is no public collector listing. Admins can see owner names and manage assignments.

Legacy owners enter their old name and PIN at `/legacy` once. Relics retain their original owner association and acquire a device collection association. The PIN cannot move that collection again. Releasing a relic clears both associations so the next visitor can claim it.

## Admin tools

`/admin/login` begins the PetalBoard-style Authentik authorization-code flow with PKCE, state, nonce, signed ID-token verification and an authorized group. Register the exact callback `${ORIGIN}/login/oidc/callback`. Set `OIDC_REQUIRED_GROUP` to the existing lab admin group (default `authentik Admins`) and `RELICS_ADMIN_GROUP` to a dedicated staff group (default `relics-admins`). Membership in either exact group grants Relics admin. Bind both groups to the Authentik application with policy mode ANY; give the staff group no superuser flag, parent groups or roles. Admin sessions expire after eight hours.

`/admin` guides staff through type creation, varieties with photo upload, and quantity-based tag batches. `/admin/catalog` retains type/variety editing and ownership management. `/admin/allocate` creates up to 500 IDs per transaction and rejects overlaps. `/admin/images` edits specimen labels and artwork. `/admin/lore` edits allocation lore. `/admin/sets` groups varieties into collection sets. `/admin/nfc-writer` provides a saved writing checklist, batch filters, URL copying and locally generated downloadable QR codes. Custom catalog numbers remain available under Make tags. Use NFC Tools to write the URL, or print the QR label. Check every physical tag before locking it. Native Web NFC is not required.

Uploads accept PNG, JPEG and WebP with file-signature checks, up to 8 MB. Store them under `RELICS_UPLOADS`. Existing `/uploads/...` image paths remain supported. SVG uploads are not served. Do not commit uploads, databases, credentials or collector records.

## Deploy and migrate

Deploy only a reviewed commit on `main`. Build the root context with `apps/relics/Dockerfile`. `compose.yml` uses the existing loopback port 48217. Set `RELICS_HTTP_PORT=48218` for parallel validation while the legacy service is running. At cutover, use port 48217 after stopping the old container; the existing Traefik route stays valid.

Before deployment:

1. Take a SQLite online backup and archive uploads outside the checkout.
2. Pause writes to the legacy service during the final copy. Copy the database and uploads to a separate private data directory, owned by container UID 1000.
3. Start the new image against the copied directory. Startup adds collection, device, recovery, admin-session and migration tables in one transaction; it retains legacy tables, IDs, allocation records and owner associations.
4. Compare every legacy relic ID, owner ID and upload checksum. Check every `/relics/{id}` URL. `scripts/continuity.ts` checks the copied database against the backup and fetches all tag pages.
5. Once the replacement is healthy on 48218, stop the legacy container, take the final data copy, and recreate the replacement with `RELICS_HTTP_PORT=48217`. Check the public URL and health. Keep the old image, container and data for rollback.

After collectors begin using the new service, its database is authoritative. A rollback must account for claims and releases since cutover; restoring the old backup would lose them. Back up the new database and uploads regularly. Do not run old and new services with independent writable copies after cutover.

### Creature presentation

Makers choose Photo only, Shroomling or Snail on each type, and an optional hex color on each variety, in both the workshop and Edit catalog. Models are a fixed asset registry; names never select a model or tint. New types default to Photo only. The photo renders first and remains the fallback; only relic pages load the viewer. The local decoder and its license ship under `/creatures/draco/`.

For the imported production catalogue only, apply the initial settings after startup has migrated the **final authoritative database**, after any final data copy. Apply the same step to the separate staging copy before checking it. The runtime image includes the SQL at `/app/migrations/creature-catalog.sql`:

```sh
docker exec relics-monorepo node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; import { readFileSync } from "node:fs"; const db = new DatabaseSync(process.env.RELICS_DB); db.exec(readFileSync("/app/migrations/creature-catalog.sql", "utf8")); db.close();'
```

The transaction records `creatures-20261122` in `RelicPresentationMigration`, so a repeated deployment preserves later maker choices, including cleared settings. It configures the six imported variety IDs with approximate display colors, without changing names, photos, IDs or ownership. Do not apply this seed to an unrelated catalogue. Check the type/variety settings, `/health`, all original tag URLs and `scripts/continuity.ts` before completing cutover. Roll back to the previous image with the current data directory; the added columns and marker are ignored by the older image.

## License

The Relics source is licensed under AGPL-3.0-only, following the license family used by Point in this monorepo. Production artwork, uploads, collector records and configuration are not distributed with the source.
