# Janet's deployment checklist

Apply only after reviewing and merging the PR. All paths below are proposed artifacts; production has not been changed.

## Storage finding

Read-only `findmnt` on .14 (2026-10-07) confirmed:

```text
/services  10.10.10.12:/mnt/JeremyBearimy/Backups/Services  nfs4  rw,hard
```

Use `/services/hey-janet/recordings`, directly backed by TrueNAS. No rsync timer is needed. The compose bind refuses to create a missing host directory. Run the mount preflight before starting; never let a missing mount fall back onto .14's nearly-full root disk. Retain the NAS's existing hard-mount behavior. App health reports storage availability and free space. Establish NAS snapshot/backup retention for this directory with the NAS owner; keep/drop is not deletion.

## Build away from .14

On a CI runner or another machine with disk capacity, check out the reviewed main commit and build from the monorepo root:

```sh
docker build -f apps/hey-janet/Dockerfile -t ghcr.io/petalnet/hey-janet:REVIEWED_SHA .
docker push ghcr.io/petalnet/hey-janet:REVIEWED_SHA
```

Record the pushed digest. The compose file requires that immutable digest in `BOOTH_IMAGE`. **Do not run a Docker build on .14.** The Dockerfile is provided for this external build; it was not built on .14.

## Prepare Authentik manually

In Authentik at id.petalcat.dev, create application `hey-janet` and a confidential OAuth2/OpenID provider using authorization code flow:

- Strict redirect URI: `https://heyjanet.petalcat.dev/auth/callback`.
- Application-scoped issuer: `https://id.petalcat.dev/application/o/hey-janet/`.
- Signing key: RSA/RS256 or EC/ES256. Enable the standard `openid` and `profile` scope mappings; include `groups` in the signed ID token if using group authorization.
- Permit ordinary PetalNet users to authenticate to the provider; authentication alone does not grant curation access.
- Create dedicated `hey-janet-curators` group containing Parker only, or set `BOOTH_ADMIN_SUB` to Parker's exact provider subject. Confirm the subject from a validated token/admin view, never guess from display name or email.
- Put the client ID, secret, issuer and selected admin setting in the private deployment `.env`. Never commit them. No wildcard redirect URIs.

The optional public sign-in link is shown only when `OIDC_CLIENT_ID` is configured. Guest recording works without OIDC. Review stays inaccessible until a curator is configured. Removing a curator takes effect once their one-hour app cookie expires; rotate BOOTH_SECRET to invalidate all app sessions immediately if needed.

See the [Authentik OAuth provider documentation](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) for application-scoped discovery and [provider setup](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider/) for scope mappings.

## Apply on .14

1. Verify the merged commit and green CI. Copy `compose.yml`, `traefik.yml`, `preflight.sh` and `.env.example` from this directory into a new `/home/docker/hey-janet` deployment directory. Keep the router outside Traefik's watched directory until the backend is ready.
2. Verify the mount before creating anything: `findmnt -M /services` must show exactly the TrueNAS export above. Create `/services/hey-janet/recordings` as uid/gid 1000 with mode 0700. If NAS root-squash/ACLs prevent that, fix ownership through the NAS administrator; do not change export settings or use a local fallback.
3. Run the importer once with the app stopped:

   ```sh
   python3 apps/hey-janet/scripts/import-prototype.py \
     /home/docker/astra-work/hey-janet-booth-src/hey-janet-booth/recordings/parker \
     /services/hey-janet/recordings
   ```

   Confirm 40 WAVs, 40 sidecars and 40 journal lines under `parker_parker`. Confirm the pos_17 flag and undecided review state. The importer validates hashes on re-run and preserves decisions.

4. Copy `.env.example` to `.env`, chmod 0600, fill OIDC settings and immutable BOOTH_IMAGE digest. Generate a signing secret without printing it, for example append `BOOTH_SECRET` with a private script using `secrets.token_hex(32)`; remove the placeholder first. Keep this key stable across restarts so queued sessions remain valid.
5. From `/home/docker/hey-janet`, run `sh preflight.sh`, then `docker compose --env-file .env config --quiet`. Port 8806 was free during inspection; recheck it at deploy time. Port 8796 belongs to proton-mail-mcp and must not be used.
6. Run `docker compose pull` and `docker compose up -d`. Check `docker compose ps` and `curl --fail http://127.0.0.1:8806/health`. Do not print environment variables or rendered compose config containing secrets. Run one replica.
7. Copy the reviewed router file into `/home/docker/traefik/dynamic/hey-janet.yml`. The router follows existing host-network loopback service patterns and inherits static TLS/entrypoint settings. Verify DNS for heyjanet.petalcat.dev points to the same public ingress and verify a valid HTTPS certificate. Do not add forward-auth to the entire booth: guest recording is intentionally public.
8. Verify Traefik supplies `X-Forwarded-Proto: https` and the real client address. The backend binds only to loopback, trusts one proxy hop, and uses ORIGIN for its own explicit write-origin check. SvelteKit 3's adapter-node 6 derives request URLs from forwarded headers; ORIGIN alone does not configure it.
9. Run a real-phone HTTPS smoke test: guest consent/name, mic permission allowed/denied, one recording and playback, disconnect/reconnect, reload, and final upload confirmation. Repeat once on physical iPhone Safari; desktop WebKit emulation does not prove device permission behavior.
10. Sign in as Parker, confirm imported clips and pos_17 flag, keep a disposable test clip, export and unzip it, inspect 16 kHz/mono/16-bit format, then drop the test clip. Verify an ordinary PetalNet account and an unsigned browser cannot access `/admin`, audio URLs or export. Verify the consent deletion route with Parker before sharing the public link widely.

## Operational checks and rollback

Inspect disk usage on the NAS, the backend healthcheck, and upload failures after release. No recording content or provider tokens are logged by application handlers. Rate limits intentionally apply to uploads and sessions, not only UI navigation. A whole household shares an IP budget; adjust the documented limits if actual invitation traffic requires it.

For rollback, remove only this router file from the watched Traefik directory (move it to a named backup), stop only the `hey-janet` compose service, and restore the prior immutable image digest if one exists. Never run `docker compose down -v`; keep the NAS recording directory. Do not remove other services or kill listeners by port.

For a participant deletion request, Parker identifies the stable participant ID from their name, approximate recording date and signed-in subject when available. Janet stops this service, backs up the metadata according to the agreed retention policy, and removes only the confirmed participant folder and any already-exported training copies, including relevant backup retention where required. Curation's Drop button never claims to erase audio. Confirm completion with the requester through the person who sent the link. No public deletion endpoint is exposed.
