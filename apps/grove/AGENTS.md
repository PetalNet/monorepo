# Grove development in an orb

From the repository root, run `.agents/ensure-grove`. It idempotently ensures the supervised
`grove` and `grove-oidc` services, repairs stopped or unhealthy services, checks `/__dev/preflight`,
and prints machine-readable JSON. Use its `grovePortal` and `oidcPortal` HTTPS URLs. Portal manifests
are `.amp/portals/grove.json` and `.amp/portals/grove-oidc.json`.

## Development authentication

Run `set -euo pipefail`, then set
`grovePortal=$(jq -er '.links[0].url | rtrimstr("/")' .amp/portals/grove.json)` before using the
commands below. Capture curl output before passing it to `jq -e` so HTTP failures cannot be masked.

- Inspect the endpoint inventory with
  `inventory=$(curl --fail-with-body --silent --show-error "$grovePortal/__dev"); jq -e . <<<"$inventory"`.
- Open `$grovePortal/__dev/log-me-in/operator?returnTo=/` to sign in as the sole development owner.
  This is an alias into the real auto-approved Authorization Code + PKCE + nonce OIDC flow, so it
  redirects through the OIDC portal before returning.
- Open `$grovePortal/__dev/log-me-out?returnTo=/` to invalidate the Better Auth session and clear its
  cookie.
- Diagnose a fresh or running orb with
  `preflight=$(curl --fail-with-body --silent --show-error "$grovePortal/__dev/preflight"); jq -e . <<<"$preflight"`.
  A logged-out browser is optional health, not a failed environment. This GET only inspects existing
  Better Auth and Actor state; it never provisions an identity or Agent.

Browser cookies authorize only browser requests. Every Agent needs a unique, durable MCP subject and
explicit enrollment. After the operator has logged in at least once, enroll from the repository root:

```bash
vp node --use-system-ca tools/enroll-grove-dev-agent.mjs \
  --subject '<unique-durable-agent-subject>' \
  --name '<Agent display name>'
```

The script uses the official MCP v2 client. Its client-credentials provider obtains a short-lived
development token with the enrollment scope, pins the issuer and resource from the portal manifests,
and calls `agents.enrollSelf`. It prints no token or secret. Retrying the same subject is idempotent;
use a new subject for a different Agent. `GROVE_MCP_CLIENT_SECRET` may override the orb-only default.

The checked-in MCP credential is intentionally shared because every operator of this disposable orb
is a trusted owner who can already change its code and database. Any operator can choose or impersonate
any Agent subject. This is never production-safe: keep browser and MCP trust separate, never copy the
credential/issuer behavior into production, and do not add per-Agent credential issuance to this demo.

## Observation and recovery

- Stable logs: `.amp/in/grove.log`, `.amp/in/grove-oidc.log`, and the bounded forwarded browser log
  `.amp/in/grove-browser.log`.
- Supervisor logs: `amp orb service logs grove` and `amp orb service logs grove-oidc`.
- Restart-stable development signing material: `.amp/state/grove-oidc-signing-key.json` (mode 0600;
  never print or copy it into artifacts).
- Review artifacts belong in `.amp/in/artifacts/`.
- Recover any service state by rerunning `.agents/ensure-grove`; the services are owned by
  `.amp/services.yaml`. If an existing `grove-postgres` has incompatible image, port, database, or
  user setup, ensure preserves its demo data and prints the explicit owner command required to replace it.

All `/__dev` shortcuts require both SvelteKit development mode and `GROVE_ORB_DEV_AUTH=1`. The issuer,
shared development credentials, broad orb portal hosts, and owner-by-design policy are development
fixtures only. Production remains provider-generic and fail-closed; never enable the orb flag or reuse
these credentials in a deployed runtime.
