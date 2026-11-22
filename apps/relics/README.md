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

`/admin/login` begins the PetalBoard-style Authentik authorization-code flow with PKCE, state, nonce, signed ID-token verification and a required group. Register the exact callback `${ORIGIN}/login/oidc/callback`. Set `OIDC_REQUIRED_GROUP` to the authorized admin group. Admin sessions expire after eight hours.

`/admin` manages types, varieties and ownership. `/admin/allocate` creates up to 500 IDs per transaction and rejects overlaps. `/admin/images` edits specimen labels and artwork. `/admin/lore` edits allocation lore. `/admin/sets` groups varieties into collection sets. `/admin/nfc-writer` copies canonical URLs, steps through allocated tags, and records writing progress. Use NFC Tools to write the URL, or encode it in a QR label. Check every physical tag before locking it. Native Web NFC is not required.

Uploads accept PNG, JPEG and WebP with file-signature checks, up to 8 MB. Store them under `RELICS_UPLOADS`. Existing `/uploads/...` image paths remain supported. SVG uploads are not served. Do not commit uploads, databases, credentials or collector records.

## Deploy and migrate

Deploy only a reviewed commit on `main`. Build the root context with `apps/relics/Dockerfile`. `compose.yml` keeps the replacement on loopback port 48218 while the legacy service remains on 48217. Traefik’s Relics service must switch to 48218 only after health and data checks pass.

Before deployment:

1. Take a SQLite online backup and archive uploads outside the checkout.
2. Pause writes to the legacy service during the final copy. Copy the database and uploads to a separate private data directory, owned by container UID 1000.
3. Start the new image against the copied directory. Startup adds collection, device, recovery, admin-session and migration tables in one transaction; it retains legacy tables, IDs, allocation records and owner associations.
4. Compare every legacy relic ID, owner ID and upload checksum. Check every `/relics/{id}` URL. `scripts/continuity.ts` checks the copied database against the backup and fetches all tag pages.
5. Switch Traefik, check the public URL and health, then stop the legacy container. Keep the old image, data and proxy config for rollback.

After collectors begin using the new service, its database is authoritative. A rollback must account for claims and releases since cutover; restoring the old backup would lose them. Back up the new database and uploads regularly. Do not run old and new services with independent writable copies after cutover.
