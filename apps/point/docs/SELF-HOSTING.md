# Self-hosting a Point home-server

Point is a home-server you run yourself. Your friends can register on it, or run
their own and federate with you. Every location fix is MLS-encrypted end to end,
so your server relays ciphertext it can't read — self-hosting doesn't make you
the person who can see everyone's location. It makes you the person who runs the
mail office, not the one who steams envelopes open.

This guide gets a production instance online with automatic TLS. Budget ~10
minutes plus DNS propagation.

## What you need

- A Linux host with Docker + the Docker Compose plugin, reachable from the
  internet on ports **80** and **443**.
- A domain (or subdomain) you control, e.g. `point.example.org`.
- An A (and AAAA, if you have IPv6) record pointing that name at the host.

That's it — no build toolchain. The server image is pulled from GHCR.

## First run

```sh
# From a checkout of the repo, in apps/point/ (or copy these three files:
# docker-compose.yml, .env.example, and — for local builds — docker-compose.build.yml)
cp .env.example .env
```

Edit `.env` and set the four required values:

| Variable            | What                                                        |
|---------------------|------------------------------------------------------------|
| `DOMAIN`            | Public hostname, e.g. `point.example.org` (bare host)      |
| `ACME_EMAIL`        | Your email for the Let's Encrypt account                   |
| `JWT_SECRET`        | 32+ random chars — `openssl rand -hex 32`                  |
| `POSTGRES_PASSWORD` | A strong DB password — `openssl rand -hex 24`              |

Then bring it up:

```sh
docker compose up -d
```

On the first HTTPS request Traefik obtains a Let's Encrypt certificate for
`$DOMAIN` automatically (TLS-ALPN challenge on :443). Verify:

```sh
curl https://point.example.org/health          # -> {"ok":true}
curl https://point.example.org/.well-known/point # federation descriptor
```

The stack is three containers: **Traefik** (TLS termination + HTTP→HTTPS
redirect), **point-server** (plain HTTP on :8330, never exposed directly), and
**Postgres** (data in the `point-pgdata` volume). Migrations run automatically on
server start.

## Registration

`OPEN_REGISTRATION` defaults to `false` — your instance is invite-only. Flip it
to `true` in `.env` and `docker compose up -d` to let anyone register, or keep it
closed and hand out invites. Point people at `https://$DOMAIN` from the app's
"add server" screen.

## Federating with other instances

Nothing to configure. Any two reachable Point instances federate on demand: when
your user shares with `bob@their.example`, your server discovers theirs via
`/.well-known/point`, and the two relay **ciphertext only** over a signed
server-to-server channel. Trust is TOFU-pinned per contact — a remote identity
key that changes later is rejected until re-verified. See
[`docs/legacy/server-map.md`](legacy/server-map.md) §5 for the protocol and
`server/src/api/federation.rs` for the implementation.

Requirements for your instance to be federatable:

- Reachable over HTTPS at `$DOMAIN` with a valid cert (the Traefik setup above).
- `PUBLIC_URL` correct (defaults to `https://$DOMAIN`; only set it if peers reach
  you at a different URL).

## Bring your own reverse proxy

Traefik is a convenience, not a requirement. To use Caddy/nginx/an existing
proxy instead: delete the `traefik` service and the `point-server` `labels:`
block from `docker-compose.yml`, publish `point-server` on a port you choose, and
route your proxy to it. point-server speaks **plain HTTP by design** — TLS is
always terminated at the proxy. If your proxy sits in front, keep
`TRUST_PROXY_HEADERS=true` and make sure the proxy sets `X-Real-Ip` to the real
client address (Traefik does this by default) so rate limits key off the client,
not the proxy. If you expose the server directly, set `TRUST_PROXY_HEADERS=false`
— otherwise clients could spoof their own rate-limit bucket via the header.

## Building from source instead of pulling

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

This compiles `point-server` from the Cargo workspace (`core/` + `server/`) via
the multi-stage `server/Dockerfile` rather than pulling from GHCR.

## Operations

**Logs**

```sh
docker compose logs -f point-server
```

**Backups.** Everything durable lives in Postgres (the `point-pgdata` volume).
Locations and MLS state are ciphertext at rest, but back it up anyway — it holds
accounts, shares, and the encrypted key-backups users rely on for account
recovery:

```sh
docker compose exec postgres pg_dump -U point point > point-backup.sql
```

**Upgrades.** Pin `POINT_VERSION` to a release tag in `.env` (don't run `latest`
blind in production), then:

```sh
docker compose pull point-server && docker compose up -d point-server
```

Migrations apply automatically on start.

## Account recovery (zero-knowledge)

Point stores an **encrypted backup of each user's MLS state** on the server so a
user who loses their phone can recover their end-to-end sessions on a new device.
The backup is encrypted on the device with a key derived from a **recovery code**
that only the user holds — the server stores ciphertext plus a KDF salt and never
sees the code or the state. See [`docs/RECOVERY.md`](RECOVERY.md) for the design
and the user-facing flow. As the operator you don't manage keys; you just keep
Postgres backed up.

## Security posture

- **Ciphertext-only relay** — the server never sees plaintext location or MLS
  state; a cross-instance share stays fully end-to-end encrypted.
- **Fail-closed authorization** — every delivery decision routes through the
  `authz` gate; the default is deny.
- **Honest boot** — the server refuses to start on a missing/weak `JWT_SECRET`
  or a malformed `DOMAIN` rather than limping insecurely.
- **SSRF-guarded federation** — outbound server-to-server calls resolve and pin
  the target IP and reject private/loopback addresses (DNS-rebind defense).
