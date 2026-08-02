# Better Auth + Authentik deployment

Lab Console uses Better Auth as an OIDC **client** and Authentik remains PetalNet's upstream SSO
provider. Do not enable Better Auth's `oidcProvider` plugin.

## Authentik provider/application

Create one confidential OAuth2/OIDC provider and application for the deployed console. The demo
deployment uses the unified service/application `console-demo` and Better Auth provider ID `oidc`:

- Client type: confidential; authorization-code flow.
- Redirect URI (exact for demo): `https://console-demo.petalcat.dev/api/auth/oauth2/callback/oidc`.
- Scopes: `openid profile email` by default. Add custom scopes only when their claims are actually
  mapped and consumed; the current runtime does not request `groups`.
- Subject mode: stable Authentik user ID. The profile must include `preferred_username`, `email`,
  `name`, and a `groups` array. Only exact membership in `authentik Admins` or `admin` is inherited
  from Authentik; either maps to the console `owner` tier. Other tiers are managed in Better Auth
  and are not inferred from Authentik group names.
- Issuer: the Authentik application provider issuer; demo uses
  `https://auth.petalcat.dev/application/o/console-demo/`. Its discovery document must be available at
  `<issuer-without-trailing-slash>/.well-known/openid-configuration`.

## Runtime environment

There is one unified SvelteKit service. Configure it with `DATABASE_URL`, `BETTER_AUTH_URL`,
`BETTER_AUTH_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`. Optional
`OIDC_REDIRECT_URI` overrides Better Auth's callback and `OIDC_SCOPES` is a comma-separated list
(default `openid,profile,email`). Store a freshly generated Better Auth secret in the lab vault as
`console-better-auth-secret`; never put it in Git. Configure SvelteKit with
the `OIDC_*` values from the Authentik client. Better Auth uses deployment-derived cookie prefixes
with `Secure` on HTTPS, `HttpOnly`,
`SameSite=Lax`, and `Path=/`; do not configure a parent cookie domain. `SameSite=Lax` allows the
short-lived OAuth state cookie on Authentik's top-level GET callback without exposing it on
cross-site subrequests; Better Auth stores the PKCE verifier in its server-side verification row.
Browser API calls and `/api/auth/*` are served by the same SvelteKit process. Better Auth sessions expire
after five minutes and are not extended, bounding Authentik group and `TERM_ADMIN` revocation lag.

Authentication storage is created by the ordered app migrations:
`migrations/0001_foundation.sql` contains the Better Auth tables and
`migrations/0002_console_domain.sql` contains the console's Better-Auth principal mapping. The
normal migration runner applies both; there is no separate generated Better Auth migration.

## Browser boundary

Browser requests authenticate only through the Better Auth session cookie. Authentik claim headers
are never accepted by console-api; the OIDC callback maps signed claims into the server-side session.
