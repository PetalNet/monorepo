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
`turbo-cache.petalcat.dev` through the Cloudflare tunnel. **Do not attach Authentik
forward-auth:** Turbo sends bearer tokens and cannot follow login redirects.
Check both exchanger routes after installing the routing configuration:

```bash
set -euo pipefail
curl --fail --silent --show-error https://turbo-cache.petalcat.dev/.well-known/jwks.json | jq -e '.keys[0].kty == "RSA"'
test "$(curl --silent --show-error -o /dev/null -w '%{http_code}' -X POST https://turbo-cache.petalcat.dev/exchange)" = 401
```

Docker mounts the dataset for the cache and eviction containers alone (a named NFS
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

## Upstream constraints

[ducktors JWT authorization](https://github.com/ducktors/turborepo-remote-cache/blob/v2.14.3/src/plugins/remote-cache/auth/jwt.ts)
trusts one issuer and one JWKS endpoint. The exchanger combines the three identity
providers and emits `scope` plus `teams`. Keep `JWT_READ_SCOPES=read`,
`JWT_WRITE_SCOPES=write`, and `JWT_TEAM_CLAIM=teams`; empty scope requirements
permit any valid token.

Its JWT dependency accepts RS256 and EdDSA, but not ES256. This exchanger uses
RS256. ducktors' `/v8/clean` endpoint requires write access, so eviction operates directly on storage.

The integration test runs the pinned ducktors image with docker and host networking.
It is skipped on machines without docker and required in CI.
