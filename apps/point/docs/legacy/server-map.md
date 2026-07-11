# Legacy point-server — deep survey (reference for the rebuild)

*Produced 2026-07-11 by a read-only survey of `/home/docker/point/point-server/`. This is the
ground-truth inventory the greenfield server design lifts from. Legacy is SQLite-only (all SQL
needs Postgres translation: `$1` placeholders, `now()`, `ON CONFLICT`, `BOOLEAN`, `BYTEA`).
Migrations present: 001–005, 007–016 (16 numbers, 15 files).*

## 1. Auth (local accounts)

- Files: `src/api/auth.rs`; extractor `src/api/mod.rs:44-83`; users DB `src/db/users.rs`.
- **Argon2**: `Argon2::default()` + `SaltString::generate(OsRng)`, PHC string stored.
  **Params are crate defaults, NOT pinned** (argon2 0.5 default = Argon2id, v19, m=19456 KiB,
  t=2, p=1). Passwords >128 bytes rejected pre-hash (DoS guard).
- **JWT HS256**: claims `{sub: user_id, is_admin, exp, iat}`; 7-day expiry;
  `Header::new(Algorithm::HS256)` + `Validation::new(Algorithm::HS256)` (alg-confusion pinned).
- **Revocation**: `users.password_changed_at` (migration 016). REST extractor rejects tokens with
  `iat < password_changed_at`. **The WS auth path does NOT re-check this** (legacy gap).
- Registration: username 3–32 alnum/`_`/`-`; id = `username@DOMAIN`; display_name sanitized
  (strips `<>&`, control, zero-width, bidi, BOM); first user auto-admin; invite required unless
  OPEN_REGISTRATION; enumeration-safe errors.
- Rate limits (in-memory DashMap, never GC'd): login/register 10/min per username + per
  `x-real-ip`; registration 5/min global.

## 2. Authz — what legacy ACTUALLY enforces (differs from the spec's model)

Sender-driven, in WS handlers (`src/ws/handler.rs` `handle_location_update` :161-318,
`handle_location_batch_update` :323-485):

1. Global ghost kill-switch `users.ghost_active` — if set, drop everything. **Per-target ghost
   does not exist in legacy.**
2. `recipient_type == "group"`: fan out to all members. **Sender's membership NOT checked;
   per-member `sharing` flag + schedule NOT enforced.**
3. `recipient_type == "user"` local: `db::shares::are_sharing(a,b)` — counts rows in
   `user_shares` (canonical min/max ordering). Err → drop (fail-closed).
4. **`temporary_shares` are NEVER consulted in delivery** (`get_temp_shares_for_recipient` has
   zero call sites). Temp shares don't actually authorize anything in legacy.
5. Zone consent bookkeeping only (`has_consent` never called).
6. Federated inbound location re-checks only the local recipient's ghost — does NOT verify a
   share exists between the federated sender and local user (legacy gap).

`are_sharing` is also the gate for history reads, MLS key fetch, and nudges.

**Rebuild mandate (spec §02): enforce the full model server-side — accepted share OR active temp
share OR shared-group membership (sender must be a member), never when ghosted (global or
per-target), fail-closed on error.**

## 3. Schema inventory (SQLite; translate to Postgres)

- `users`: id TEXT PK (`user@domain`), display_name, password_hash, avatar BLOB, is_admin,
  ghost_active (014), is_federated (015, shadow rows w/ empty hash), password_changed_at (016).
- `devices`: id, user_id, name, mls_key_package BLOB (unused — real KPs in `key_packages`),
  push_token, last_seen.
- `groups` + `group_members` (role default member/admin; precision; schedule_*; sharing BOOL;
  notify flags). `group_invites` (code, max_uses 0=unlimited, uses, expires_at).
- `share_requests`: from,to,status pending/accepted/rejected, UNIQUE(from,to).
- `user_shares`: PK (user_a,user_b) canonical smaller-first. THE authz source of truth.
- `temporary_shares`: from_user_id, to_user_id (nullable), link_token UNIQUE (nullable),
  precision, expires_at. (Link tokens schema-only; no route consumes them.)
- `zone_consents`: (zone_owner_id, consenter_id, status). Bookkeeping only.
- `key_packages`: id, user_id, key_package BLOB, created_at.
- `mls_messages`: id, recipient_id, message_type welcome|commit, group_id, sender_id,
  payload BLOB, processed BOOL. Index (recipient_id, processed).
- `location_updates`: sender_id, recipient_type, recipient_id, encrypted_blob BLOB,
  source_type, timestamp INT, ttl INT default 300. Indexes on recipient + created_at.
- `location_history`: user_id, encrypted_blob BLOB, timestamp INT. 30-day retention.
- `invites` (server-level): code, created_by, max_uses, uses, expires_at.
- `fcm_tokens`: PK (user_id, token).
- Bridges/items/places tables exist (001/004/007/008/012) — v2/v1.5, NOT lifted into v1.
  **Plaintext leak in legacy: `places.lat/lon/radius/polygon_points` cleartext** (the known
  half-finished place encryption; places are v1.5, so v1 simply has no places tables).
- Ciphertext columns: location_updates.encrypted_blob, location_history.encrypted_blob,
  key_packages.key_package, mls_messages.payload.
- No `visibility_modes` table exists anywhere in legacy despite teardown/spec naming it.

## 4. WebSocket hub

- `GET /ws`; Origin guard: if header present must be `https://{domain}` or localhost:3000/8080.
- Auth-as-first-message: 5s timeout for `{"type":"auth","token":...}`; HS256 verify; close on
  anything else. Query-param tokens deliberately removed.
- Hub: `DashMap<user_id, Vec<(conn_id, UnboundedSender<Vec<u8>>)>>`, multi-conn per user.
- Inbound: location.update, location.batch_update, presence.update, location.nudge,
  location.subscribe (noop), bridge.*, item.location, place.triggered.
- Outbound: location.broadcast, location.nudge, presence.update, mls.message, notification
  pushes (share.request/accepted/rejected/temp_created, zone.consent_*).
- Batch: stores every fix to history, broadcasts only the latest.
- Per-connection rate limits (60s windows): location.update/batch 60/min, nudge 10/min,
  presence 30/min, other 120/min.
- Presence: broadcast to all members of all sender's groups, deduped.
  `{user_id, online, battery, activity}`.
- Nudge: requires are_sharing; FCM wake-push if target offline.

## 5. Federation (signed S2S)

- Routes: `GET /.well-known/point`, `POST /federation/inbox`, `POST /api/federation/send`.
- Ed25519 keypair per server, generated on boot, persisted `{data_dir}/federation_key` (raw 32B);
  pubkey published as hex in well-known.
- Signature: `hex(sign(raw JSON bytes of FederatedMessage))` in `X-Point-Signature` header.
  Inbox re-serializes the parsed struct and verifies against that — **canonicalization is
  serde-field-order-dependent, fragile. Rebuild: sign the exact received bytes, or use a real
  canonical form.**
- Inbox flow: parse → extract sender domain → live-fetch sender's well-known (TOFU, **no
  pinning**) → require + verify signature → replay window ±300s → dispatch.
- `WellKnownResponse`: `{domain, version, federation, public_key, endpoints:{inbox, keys}}` —
  **`endpoints.keys` advertises a route that was never registered (404)**.
- SSRF blocklist is hostname-string-only (localhost/IP-literals/.local/.internal/metadata) —
  **no DNS-resolution check (rebinding passes). Rebuild: resolve + check IPs.**
- Kinds: location.update, share.request, share.accept (verifies matching outbound pending
  request — anti-forgery), mls.welcome, mls.commit, mls.key_request, location.nudge.
- Shadow users via ensure_federated_user.

## 6. KeyPackages — the consumption bug

- `POST /api/mls/keys` upload 1–5 per request, ≤10 stored, ≤2KB each.
- `GET /api/mls/keys/{user}` (authz: own | are_sharing | shared group) and the federated
  key_request both return **ALL stored packages and never consume any** — `delete_key_package`
  has zero call sites. One package effectively serves everyone forever (init-key reuse).
- **Rebuild: atomic `DELETE ... RETURNING` one package per fetch + last-resort fallback +
  client re-upload cadence.**

## 7. REST route inventory (59 routes)

Auth: POST /api/register, /api/login; DELETE /api/account; PUT /api/account/password;
POST /api/fcm/token.
Groups: POST/GET /api/groups; GET/DELETE /api/groups/{id}; PUT .../settings; PUT .../me;
POST .../invite; POST /api/groups/join/{code}; POST/DELETE .../members[/{id}]; PUT .../role.
Items (v1.5 — not lifted): POST/GET/DELETE /api/items, share/unshare.
Shares: GET /api/shares; POST/GET /api/shares/temp; DELETE /api/shares/temp/{id};
POST /api/shares/request; GET /api/shares/requests[/outgoing]; POST .../{id}/accept|reject;
DELETE /api/shares/{user_id}.
Zone consent (bookkeeping): request/incoming/granted/accept/reject/delete.
Places (v1.5 — not lifted): group + personal place CRUD.
Invites: POST/GET/DELETE /api/invites.
History: GET /api/history/{user_id} (since/limit≤1000); DELETE /api/history.
Ghost: PUT /api/ghost.
Federation: GET /.well-known/point; POST /federation/inbox; POST /api/federation/send.
MLS: POST /api/mls/keys; GET /api/mls/keys/{user_id}; POST /api/mls/welcome;
POST /api/mls/commit; GET /api/mls/messages; POST /api/mls/messages/{id}/ack.
Admin: GET /api/admin/info. WS: GET /ws.

## 8. Other load-bearing pieces

- Config (clap+env): DATABASE_URL, LISTEN, JWT_SECRET (required; legacy has NO ≥32-char check —
  the rebuild adds it), DOMAIN, OPEN_REGISTRATION (legacy default true; rebuild default false).
- CORS allow-list: https://{domain} + localhost:8080/:3000.
- Cleanup task 60s: expired location_updates (TTL), expired temp shares, history >30 days.
- FCM: service-account JWT → OAuth2 token (cached ~58min); data-only high-priority content-free
  wake pushes `{type, t}`.
- Errors: JSON `{"error":...}`; unique-violation → 409 (Postgres SQLSTATE 23505 in rebuild).
