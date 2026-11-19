# PetalNet Turbo cache

| Identity         | Access     | Required evidence                                                                                                                     |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub main push | Read/write | `repository=PetalNet/monorepo`, `repository_id=1254675438`, `repository_owner_id=217980753`, `event_name=push`, `ref=refs/heads/main` |
| Same-repo PR     | Read       | Same name and IDs, `pull_request` event, GitHub API confirms head and base repositories                                               |
| Amp orb          | Read       | Configured workspace and project IDs, `token_use=exchanged`                                                                           |
| Authentik user   | Read       | Exact configured issuer, `turbo-cache` group                                                                                          |
| Everything else  | Denied     | Includes forks, merge groups, Dependabot, `pull_request_target`, and invalid or expired tokens                                        |

All callers need a valid issuer signature and audience `turbo-cache.petalcat.dev`.
The exchanger issues two-hour tokens. Only a main-push identity can write. A fork
cannot satisfy that event/ref policy, and cannot obtain a PR read token: GitHub's
OIDC token lacks a head-repository claim, so the exchanger checks the signed PR
number through GitHub's API. Missing credentials or API failures deny PR access.
The repository name and immutable IDs must all match to prevent transfer or rename squatting.

## Home page

`GET /` on the exchanger is a status page: artifact count and bytes against the cap, the last
eviction pass, remote hits and misses over 24 hours, the policy table above and the local
connection steps. `/stats.json` has the same numbers, and the page refreshes itself from `/_live`.
None of it carries token or key material.

- Storage numbers and the last eviction time come from `/state/storage.json`, which the
  eviction sidecar rewrites after every pass.
- Hit and miss counts come from the events Turbo posts to `POST /v8/artifacts/events` after
  each remote lookup. The route sends that one path to the exchanger, which forwards it to
  ducktors unchanged and counts the `REMOTE` `HIT`/`MISS` events only when ducktors accepted
  the token. Counts live in hourly buckets in `/state/events.json` (the `state` volume), so a
  redeploy keeps them. Local-only hits never reach the server.

## Deploy

Compose pulls `ghcr.io/petalnet/turbo-cache:<commit-sha>` and never builds an image.

| Variable                        | Value                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `TURBO_CACHE_IMAGE_SHA`         | Published exchanger image's commit SHA                                                              |
| `TURBO_CACHE_NFS_ADDRESS`       | NAS address that exports the dedicated dataset                                                      |
| `TURBO_CACHE_NFS_EXPORT`        | Export of the dedicated 50 GiB dataset (`:/mnt/<pool>/turbo-cache`), writable by UID/GID 1001:1001  |
| `TURBO_CACHE_MAX_BYTES`         | Optional eviction cap in bytes; defaults to 40 GiB, which leaves headroom under the 50 GiB quota    |
| `TURBO_CACHE_SIGNING_KEY_FILE`  | External RSA PKCS8 PEM key, at least 2048 bits, readable by UID 1000                                |
| `TURBO_CACHE_GITHUB_TOKEN_FILE` | External credential with Pull requests: read on PetalNet/monorepo; an empty file disables PR access |
| `AUTHENTIK_ISSUER`              | Exact provider issuer under `https://auth.petalcat.dev`                                             |
| `AUTHENTIK_JWKS_URL`            | Provider JWKS URL under `https://auth.petalcat.dev`                                                 |
| `AMP_WORKSPACE_IDS`             | Comma-separated workspace allowlist; empty denies all orbs                                          |
| `AMP_PROJECT_IDS`               | Comma-separated project allowlist; empty denies all orbs                                            |

Outside compose, `SIGNING_KEY` and `GITHUB_READ_TOKEN` accept environment secrets;
`SIGNING_KEY_FILE` and `GITHUB_READ_TOKEN_FILE` take precedence. Never commit keys.
Authentik tokens must include the dedicated audience and a `groups` array.

Install `deploy/traefik.yml` in the existing file-provider directory and route
`turbo-cache.petalcat.dev` through the Cloudflare tunnel. It sends `/`, `/_live`, `/stats.json`,
`/assets/*.woff2`, `/exchange`, `/.well-known/jwks.json` and `POST /v8/artifacts/events` to the
exchanger and everything else to the cache. **Do not attach Authentik
forward-auth:** Turbo sends bearer tokens and cannot follow login redirects.
Check both exchanger routes after installing the routing configuration:

```bash
set -euo pipefail
curl --fail --silent --show-error https://turbo-cache.petalcat.dev/.well-known/jwks.json | jq -e '.keys[0].kty == "RSA"'
test "$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X POST https://turbo-cache.petalcat.dev/exchange)" = 401
```

The exchanger and the eviction sidecar share a small local `state` volume (created mode 1777 by the
exchanger image, since the exchanger and the sidecar run as different users). Docker mounts the dataset for the cache and eviction containers alone (a named NFS
volume), `soft` with `timeo=50,retrans=2`. A hung NAS fails each read and write with
an I/O error within seconds, which Turbo treats as a cache miss, instead of freezing the
server's worker threads. Docker will not start a container whose volume fails to mount, so
the cache cannot fall back to the VM's root disk. The shared `/services` mount is untouched. A soft mount can fail a write part-way, which
leaves a truncated artifact: one failed restore or miss, replaced by the next main push.
Docker keeps a named volume's mount options once it exists, so changing
`TURBO_CACHE_NFS_ADDRESS` or `TURBO_CACHE_NFS_EXPORT` needs `docker compose down` and
`docker volume rm <project>_cache-data` first (the data lives on the NAS and is untouched).

Eviction runs every five minutes as UID/GID 1001:1001 with a read-only root filesystem and
no capabilities. When the files total more than `TURBO_CACHE_MAX_BYTES` it deletes the
least recently used until 90% of the cap remains, and it always deletes files idle for 14
days. A file's age is the later of its mtime and atime. The cache server never rewrites
an artifact it serves, so on a mount that records reads (this one: atime on, relatime) atime
carries recency, and without it eviction degrades to oldest-written first. The cap sits
below the dataset's 50 GiB quota so that in-flight uploads never hit the quota.

Cloudflare's [100 MB upload cap](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/)
limits artifact size through the tunnel. The cache's body limit is 104857600 bytes.

## Local use (read-only)

Members of the Authentik group `turbo-cache` can read the cache from a checkout. They cannot
write: only a main push can. Authentik signs the tokens (provider and application
`turbo-cache`, client ID `turbo-cache.petalcat.dev`, RS256); the exchanger turns one into a
two-hour cache token.

1. In Authentik, open User settings, Tokens and App passwords, and create an **App password**.
   An administrator adds you to `turbo-cache` first.
2. Trade it for a cache token and export the Turbo variables. Put your username and the app
   password in `AK_USER` and `AK_APP_PASSWORD` first (read the password with `read -rs`, so it
   stays out of the command line and shell history):

   ```bash
   identity=$(printf %s "$AK_APP_PASSWORD" |
     curl --fail --silent --show-error https://auth.petalcat.dev/application/o/token/ \
       -d grant_type=password -d client_id=turbo-cache.petalcat.dev -d scope='openid profile' \
       --data-urlencode username="$AK_USER" --data-urlencode password@- |
     jq -er .access_token) &&
   TURBO_TOKEN=$(curl --fail --silent --show-error -X POST -H "Authorization: Bearer $identity" \
     https://turbo-cache.petalcat.dev/exchange | jq -er .access_token) &&
   export TURBO_API=https://turbo-cache.petalcat.dev TURBO_TEAM=petalnet TURBO_TOKEN \
     TURBO_CACHE=local:rw,remote:r TURBO_REMOTE_CACHE_TIMEOUT=15
   ```

3. Run Turbo as usual. The token lasts two hours; repeat step 2 for a new one. Turbo prints
   `cache hit, replaying logs` for local and remote hits alike. To see a remote hit, run with
   `--cache=remote:r` after deleting a task's output (for example `dist`): the output comes
   back from the cache. On the LAN the host resolves to Traefik directly, and off it the
   request goes through the Cloudflare tunnel.

`curl https://turbo-cache.petalcat.dev/v8/artifacts/status` answers 200 when the server is up.

## Provisioned state

Everything outside the repository that the stack depends on, so it can be rebuilt:

- TrueNAS dataset `JeremyBearimy/turbo-cache`: 50 GiB quota, atime on, POSIX ACL, owned by
  1001:1001 (mode 0750), shared by NFS to `10.10.10.14` only.
- Authentik: group `turbo-cache`; OAuth2 provider and application `turbo-cache` (public client,
  client ID `turbo-cache.petalcat.dev`, password and authorization-code grants, RS256 with the
  default self-signed key, application bound to the group).
- Lab vault: `turbo-cache-signing-key` (RSA 3072, PKCS8) and `turbo-cache-github-token`
  (fine-grained, read-only Pull requests and Contents on this repository, expires 2027-11-19).
- .14: `/home/docker/releases/turbo-cache/<sha>` is the release checkout, `current` points at
  it, `runtime.env` (mode 600) holds the variables above, `secrets/` holds the two files projected
  from the vault, and `compose.override.yaml` gives the stack its own /24. The image is built
  there with `docker build -f apps/turbo-cache/Dockerfile -t ghcr.io/petalnet/turbo-cache:<sha> .`.
  Never delete `/data/petalnet` on the volume: the cache server creates that directory once and
  fails every upload while it is missing.
- Traefik route: `dynamic/turbo-cache.yml` in PetalNet/traefik.

## Upstream constraints

[ducktors JWT authorization](https://github.com/ducktors/turborepo-remote-cache/blob/v2.14.3/src/plugins/remote-cache/auth/jwt.ts)
trusts one issuer and one JWKS endpoint. The exchanger combines the three identity
providers and emits `scope` plus `teams`. Keep `JWT_READ_SCOPES=read`,
`JWT_WRITE_SCOPES=write`, and `JWT_TEAM_CLAIM=teams`; empty scope requirements
permit any valid token.

Its JWT dependency accepts RS256 and EdDSA, but not ES256. This exchanger uses
RS256. ducktors' `/v8/clean` endpoint requires write access, so eviction operates directly on storage.

The integration test runs the pinned ducktors image (v3.0.3, the same digest compose deploys) with docker and host networking.
It is skipped on machines without docker and required in CI.
