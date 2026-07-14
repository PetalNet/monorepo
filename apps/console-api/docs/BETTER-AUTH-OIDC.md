# Better Auth + Authentik deployment

Lab Console uses Better Auth as an OIDC **client** and Authentik remains PetalNet's upstream SSO
provider. Do not enable Better Auth's `oidcProvider` plugin.

## Authentik provider/application

Create a confidential OAuth2/OIDC provider and application for `console.petalcat.dev`:

- Client type: confidential; authorization-code flow.
- Redirect URI (exact): `https://console-demo.petalcat.dev/api/auth/oauth2/callback/authentik`.
- Scopes: `openid profile email groups`.
- Subject mode: stable Authentik user ID. The profile must include `preferred_username`, `email`,
  `name`, and a `groups` array. Only exact membership in `authentik Admins` or `admin` is inherited
  from Authentik; either maps to the console `owner` tier. Other tiers are managed in Better Auth
  and are not inferred from Authentik group names.
- Issuer: the Authentik application provider issuer, conventionally
  `https://auth.petalcat.dev/application/o/console/`. Its discovery document must be available at
  `<issuer-without-trailing-slash>/.well-known/openid-configuration`.

The demo provider (`Lab Console Demo`, provider ID 69) was verified through the Authentik API on
2026-07-13. It has the `openid`, `profile`, `email`, and custom `groups` property mappings attached,
includes mapped claims in the ID token, and its `profile` mapping emits
`preferred_username: request.user.username`. No Authentik configuration change was made. The
console mapper prefers that claim, then falls back to a validated email localpart or subject so a
missing optional profile claim cannot abort user creation; the session verifier still validates the
result before resolving any ReBAC identity.

## Runtime environment

Configure both console services with the same `DATABASE_URL`, `BETTER_AUTH_URL`, and
`BETTER_AUTH_SECRET`. Store a freshly generated secret in the lab vault as
`console-better-auth-secret`; never put it in Git. Configure SvelteKit with
`AUTHENTIK_OIDC_ISSUER`, `AUTHENTIK_OIDC_CLIENT_ID`, and `AUTHENTIK_OIDC_CLIENT_SECRET` from the
Authentik client. Better Auth uses host-only `__Host-console.*` cookies with `Secure`, `HttpOnly`,
`SameSite=Lax`, and `Path=/`; do not configure a parent cookie domain. `SameSite=Lax` allows the
short-lived OAuth state cookie on Authentik's top-level GET callback without exposing it on
cross-site subrequests; Better Auth stores the PKCE verifier in its server-side verification row.
Browser API calls go directly to console-api through same-origin `/api/v1/*`
routing, while `/api/auth/*` remains on SvelteKit. Better Auth sessions expire
after five minutes and are not extended, bounding Authentik group and `TERM_ADMIN` revocation lag.

The Better Auth CLI-generated schema is committed at `migrations/001-better-auth.sql` and the
idempotent console-api boot migration creates the same tables. Regenerate it with the Better Auth
CLI against a disposable console Postgres database after schema changes.

## Browser boundary

Browser requests authenticate only through the Better Auth session cookie. Authentik claim headers
are never accepted by console-api; the OIDC callback maps signed claims into the server-side session.
