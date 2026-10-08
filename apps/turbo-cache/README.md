# PetalNet Turbo cache

The exchanger accepts `POST /exchange` with an OIDC token in `Authorization: Bearer …`.
It returns `access_token`, `token_type`, `expires_in`, `scope`, and `team`.
Tokens last two hours. `GET /.well-known/jwks.json` publishes only the public signing key.
The cache server is unmodified ducktors v2.14.3, the latest release checked on 2026-10-08.

## Access policy

| Identity           | Grant          | Required evidence                                                                                                           |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GitHub main push   | Read and write | GitHub signature, `repository=PetalNet/monorepo`, `event_name=push`, `ref=refs/heads/main`                                  |
| GitHub merge queue | Read and write | GitHub signature, same repository, `event_name=merge_group`                                                                 |
| GitHub PR          | Read           | Same repository, `event_name=pull_request`, signed `refs/pull/N/merge`, GitHub API confirms both head and base repositories |
| Amp orb            | Read           | Amp signature, configured workspace and project IDs, `token_use=exchanged`                                                  |
| Human              | Read           | Exact configured Authentik issuer and `turbo-cache` in the `groups` array                                                   |
| Anything else      | Deny           | Includes forks, `pull_request_target`, Dependabot, missing claims, invalid signatures, wrong audiences, and expired tokens  |

GitHub's [OIDC claim list](https://docs.github.com/en/actions/reference/security/oidc)
has no head-repository claim. `repository` identifies the workflow repository and
`head_ref` identifies a branch name. Neither proves a PR is not a fork.
The exchanger looks up the signed PR number with a GitHub credential restricted to
**Pull requests: read** on PetalNet/monorepo. Missing credentials, API errors, deleted
head repositories, and Dependabot-authored PRs all deny access. The CI-side fork
check is an optimization, not the authorization boundary.

[Amp tokens](https://ampcode.com/manual/orbs/oidc) have no repository or branch evidence.
Both allowlists must match, and empty allowlists deny all orbs. A human token must
use the dedicated cache audience and include the Authentik group claim. This app
does not implement an interactive login flow.

## Configure deployment after merge

Janet owns these steps. This PR creates no production resources.

1. Merge the separate [hash-input change, PR #466](https://github.com/PetalNet/monorepo/pull/466)
   before assessing cross-environment cache hits. This branch is based on main and
   does not change `turbo.json`.
2. Create a TrueNAS dataset with a **50 GiB quota**, enable access-time updates,
   and mount it over NFS on .14. Set `TURBO_CACHE_NFS_PATH` to that existing mount.
   Configure the host service to require the mount before starting the stack.
   Match NFS ownership to ducktors UID/GID **1001:1001**, and map the eviction container's squashed root to that dataset owner.
   The cache startup checks the NFS filesystem type and refuses local storage.
3. Generate an RSA private key of at least 2048 bits outside the repository.
   Set `TURBO_CACHE_SIGNING_KEY_FILE` to its PKCS8 PEM file. Ensure the exchanger's
   container user, UID 1000, can read it. Never commit the file or its contents.
   The app also supports `SIGNING_KEY` directly; `SIGNING_KEY_FILE` takes precedence.
4. Supply the read-only GitHub credential through `TURBO_CACHE_GITHUB_TOKEN_FILE`.
   An empty file disables PR exchanges while leaving other identities usable.
   The app supports `GITHUB_READ_TOKEN` or `GITHUB_READ_TOKEN_FILE` directly.
5. Set `AUTHENTIK_ISSUER` to the exact issuer from the dedicated provider's discovery
   document, and `AUTHENTIK_JWKS_URL` to its JWKS endpoint. Both must be on
   `https://id.petalcat.dev`. Configure audience `turbo-cache.petalcat.dev` and a
   `groups` array. Set comma-separated `AMP_WORKSPACE_IDS` and `AMP_PROJECT_IDS`.
6. Build the exchanger image on a machine with space, then transfer or publish it
   for deployment. **Do not build on .14.** The Dockerfile uses the workspace
   lockfile and production-only deployment output. Validate the compose file with
   `docker compose -f apps/turbo-cache/docker-compose.yml config --quiet`.
7. Install `deploy/traefik.yml` in the existing Traefik file-provider directory.
   The existing .14 Traefik uses host networking and the `web` entrypoint, so the
   template targets loopback ports 43180 and 43181. Route `turbo-cache.petalcat.dev`
   through the existing Cloudflare tunnel to Traefik. **Do not attach Authentik
   forward-auth.** Turbo authenticates with bearer tokens and cannot follow login redirects.

The eviction sidecar runs at 03:00 UTC and deletes regular files with access times
at least 14 days old. Keep TrueNAS `atime` enabled and avoid `noatime` on the client.
Otherwise hot artifacts can be evicted based on stale timestamps. Configure quota
monitoring at 80%. NFS and this dataset are dedicated to this cache.

Cloudflare Free/Pro limits uploads to **100 MB**. The cache's `BODY_LIMIT` is
104857600 bytes. Larger artifacts cannot pass the tunnel and remain cache misses.
See [Cloudflare's upload limits](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/).

## Use a token

Request an OIDC token for audience `turbo-cache.petalcat.dev`. On an orb, use
`amp orb id-token --audience turbo-cache.petalcat.dev`. For a human, obtain a token
from the configured Authentik provider. Send it as the bearer token to `/exchange`.
Set these environment variables from the response without printing the token:

```text
TURBO_API=https://turbo-cache.petalcat.dev
TURBO_TEAM=petalnet
TURBO_TOKEN=<access_token>
TURBO_CACHE=local:rw,remote:r
```

CI requests its GitHub OIDC token in the shared `setup-turbo` action. Only jobs
using Turbo receive `id-token: write`, including the affected-task selector.
The exchange step has `continue-on-error` and bounded HTTP timeouts. It keeps the
existing `rharkor/caching-for-turbo` configuration when exchange fails or the caller
is excluded. After a successful exchange, Turbo uses PetalNet for that run. A later
cache outage produces misses; there is no mid-run switch back to GitHub cache.

## Run checks locally

```bash
corepack pnpm install --ignore-scripts --filter @petalnet/turbo-cache... --filter @petalnet/workspace
corepack pnpm prepare
corepack pnpm --filter @petalnet/turbo-cache typecheck
corepack pnpm --filter @petalnet/turbo-cache test
corepack pnpm --filter @petalnet/turbo-cache test:mutation
corepack pnpm exec eslint apps/turbo-cache knip.config.ts --max-warnings=0
corepack pnpm exec oxlint apps/turbo-cache knip.config.ts --max-warnings=0
corepack pnpm lint:knip --workspace apps/turbo-cache
corepack pnpm lint:knip:prod --workspace apps/turbo-cache
```

The integration test starts a fake issuer and PR API on loopback, generates fresh
keys, runs the real Effect HTTP handler, and starts the published ducktors package
in a child Node process. No Docker build, external identity service, or LLM call is
needed. It tests writes, reads, team isolation, denial paths, JWKS caching, and TTL.
The mutation command temporarily removes six authorization gates, requires an
assertion failure for each, and restores the original source in `finally`.
Run mutation checks separately from other checks of the same source tree.

## Upstream constraints

[ducktors authorization](https://github.com/ducktors/turborepo-remote-cache/blob/v2.14.3/src/plugins/remote-cache/auth/jwt.ts)
uses one issuer and one JWKS endpoint. We configure `JWT_SCOPE_CLAIM=scope`,
`JWT_READ_SCOPES=read`, `JWT_WRITE_SCOPES=write`, and `JWT_TEAM_CLAIM=teams`.
Leaving scope requirements empty permits any valid token, so keep both set.
Its JWT dependency accepts RS256 and EdDSA, but not ES256. The integration test
caught ES256 returning 401; this exchanger signs RS256.

The package publishes no TypeScript declarations, so the integration test starts
its public JavaScript entrypoint in a child process. Its `/v8/clean` endpoint needs
a writer token; storage-side eviction avoids distributing one to a scheduler.
Readers receive 403 for writes. Invalid cache tokens receive 401.

Key rotation currently invalidates outstanding tokens after JWKS caches refresh.
Keep the old key for rollback and expect cache misses during rotation. Artifact
signing, human write access, and an upstream multi-issuer proposal are follow-ups.
