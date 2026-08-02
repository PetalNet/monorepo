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
# From a checkout of the repo, in apps/point/. For a published-image install,
# docker-compose.yml and .env.example are sufficient.
cp .env.example .env
```

A source build requires the full `apps/point` checkout: the build context includes
the Cargo workspace, `core/`, `server/`, and `server/Dockerfile`. Copying only the
Compose override is not sufficient.

Edit `.env` and set the four required values:

| Variable            | What                                                  |
| ------------------- | ----------------------------------------------------- |
| `DOMAIN`            | Public hostname, e.g. `point.example.org` (bare host) |
| `ACME_EMAIL`        | Your email for the Let's Encrypt account              |
| `JWT_SECRET`        | 32+ random chars — `openssl rand -hex 32`             |
| `POSTGRES_PASSWORD` | A strong DB password — `openssl rand -hex 24`         |

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

There is no separate federation switch. Any two reachable Point instances
federate on demand: when
your user shares with `bob@their.example`, your server discovers theirs via
`/.well-known/point`, and the two relay **ciphertext only** over a signed
server-to-server channel. Trust is TOFU-pinned per contact — a remote identity
key that changes later remains rejected. There is currently no supported key-reset
or repinning flow; investigate the remote instance rather than bypassing the pin. See
`../server/src/api/federation.rs` for the current implementation. The
[`legacy server map`](legacy/server-map.md) describes the predecessor only.

Requirements for your instance to be federatable:

- Reachable over HTTPS at `$DOMAIN` with a valid cert (the Traefik setup above).
- `PUBLIC_URL` correct (defaults to `https://$DOMAIN`; only set it if peers reach
  you at a different URL).
- Public DNS must resolve to a routable address. Production federation rejects
  loopback, private, link-local, and otherwise unsafe destinations and pins the
  validated address for the outbound request. Never enable the test-only
  `FEDERATION_ALLOW_PRIVATE` escape hatch in production.
- The remote server must expose a valid `/.well-known/point` descriptor and
  `POST /federation/inbox`. The sending server signs the exact request bytes with
  its private Ed25519 server key; its descriptor publishes the corresponding
  public key for receivers to verify. Receivers also apply replay and rate-limit
  checks.

## Maps

The app offers three honest map tiers; your instance decides which are on the
menu. Each is exactly what it says. No tier pretends a tracking provider is
"a little private."

**Self-hosted tiles (max private).** The bundled `tileserver` service renders
OpenStreetMap data from a single PMTiles file on your disk, in Point's
monochrome style. Map data never leaves your server. One-time setup:

```sh
# 1. The pmtiles CLI (single static binary): https://github.com/protomaps/go-pmtiles
# 2. Extract your region from the latest Protomaps build (~tens of MB for a
#    metro area, ~GBs for a continent). Find bounds at https://boundingbox.klokantech.com
mkdir -p tileserver/data
pmtiles extract https://build.protomaps.com/$(date -u -d yesterday +%Y%m%d).pmtiles \
  tileserver/data/basemap.pmtiles --bbox=-90.75,38.35,-89.90,38.95

# 3. Label fonts (any release of the OpenMapTiles font pack):
mkdir -p tileserver/fonts && curl -L https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip \
  -o /tmp/fonts.zip && unzip -q /tmp/fonts.zip -d tileserver/fonts

# 4. Bring it up and advertise it:
docker compose --profile tiles up -d
```

Then set in `.env` and restart the server:

```sh
TILES_URL=https://$DOMAIN/tiles/styles/point-dark/{z}/{x}/{y}.png
```

The server advertises this in `/.well-known/point`; apps connected to your
instance render their "your own server" map from it. Without it, that choice
falls back to a public OpenStreetMap mirror and the app says so.

**Proxied provider (convenient).** Set `TILE_UPSTREAM` to a commercial tile
URL with your API key baked in (Stadia and Protomaps API work well and have
free tiers). Your server fetches tiles on members' behalf: the provider sees
one server IP and one key, never a user, a device, or an account. Unset =
the app's proxied choice falls back to the public mirror.

**Google (not offered here).** Google's terms forbid proxying its tiles, so
it cannot be cleaned; if it ever ships it will be as an explicit, labeled
opt-in in the app that talks to Google directly. Nothing on the server side
involves Google.

## Bring your own reverse proxy

Traefik is optional. Do not edit the tracked compose file. Create
`compose.proxy.yml` beside it:

```yaml
services:
  point-server:
    ports:
      - "127.0.0.1:8330:8330"
    environment:
      TRUST_PROXY_HEADERS: "true"
    labels:
      - traefik.enable=false
```

Start only Postgres and Point, applying the override that publishes container
port 8330 on the host's loopback port 8330:

```sh
docker compose -f docker-compose.yml -f compose.proxy.yml up -d postgres point-server
```

Route Caddy/nginx to `http://127.0.0.1:8330`, terminate TLS there, and have the
proxy **overwrite** (not append an untrusted value to) `X-Real-IP` with the
connecting client's address. Keep `TRUST_PROXY_HEADERS=true` only for this
trusted-proxy topology.

If Point is directly reachable by clients, the base Compose file's hard-coded
`TRUST_PROXY_HEADERS: "true"` must be overridden; setting it only in `.env` has
no effect. Add this to the override before publishing the port:

```yaml
services:
  point-server:
    environment:
      TRUST_PROXY_HEADERS: "false"
```

Otherwise a client can spoof the rate-limit address. Do not publish 8330 on
`0.0.0.0` merely to reach a proxy running on the same host.

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

Test restores, not just dumps. To restore into a clean database (this replaces
that database's Point state):

```sh
docker compose stop point-server
docker compose exec -T postgres dropdb -U point --if-exists point
docker compose exec -T postgres createdb -U point point
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U point -d point < point-backup.sql
docker compose up -d point-server
curl https://point.example.org/health
```

If `POSTGRES_USER` or `POSTGRES_DB` differs from the defaults, substitute those
values. Keep the dump encrypted and off-host; it includes accounts, relationship
metadata, server signing material, and user recovery ciphertext. A restore rolls
all of that state back to the dump time.

**Image pinning and upgrades.** `POINT_VERSION` is interpolated after
`ghcr.io/petalnet/point-server:`. Pin a release tag (for example `1.2.12`) rather
than accepting the compose default `latest`. For reproducible production pulls,
you may pin a tag plus digest, for example
`POINT_VERSION=1.2.12@sha256:<release-digest>`; obtain the digest from the GHCR
release you intend to deploy. Back up first, then:

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
