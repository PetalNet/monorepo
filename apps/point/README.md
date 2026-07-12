# Point

**Matrix for location.** Point is a self-hostable, end-to-end-encrypted,
federatable location-sharing network. You run your own home-server, your friends
run theirs (or join yours), and locations are shared over MLS-encrypted groups
that no server — not even yours — can read.

- **Open & self-hosted** — run it yourself, own your data.
- **End-to-end encrypted** — MLS (via the `core` crate), so servers relay
  ciphertext, never plaintext location.
- **Federatable from day one** — home-servers talk to each other, like email or
  Matrix.
- **AGPL-3.0** — self-host copyleft; forks and deployments stay open.

Bridges to Find My / Google / SmartThings are planned for **v2**, not now.

## Repository layout

```text
core/     Lifted OpenMLS E2E crypto crate (reused from legacy point-core).
server/   Rust (axum) home-server + Postgres (sqlx). Plain HTTP behind Traefik.
app/      Flutter client — placeholder; rebuilt in a later wayfinder ticket.
docs/     Strategy, ghost-mode concepts, implementation plan, locked decisions.
```

## Self-host quickstart

Point a DNS record for your domain at a Docker host with ports 80/443 open, then:

```sh
cp .env.example .env
# Set DOMAIN, ACME_EMAIL, JWT_SECRET (openssl rand -hex 32), POSTGRES_PASSWORD.
docker compose up -d
```

The stack pulls the published server image from GHCR and stands up Traefik (with
automatic Let's Encrypt TLS), point-server, and Postgres. Health check:

```sh
curl https://your.domain/health   # -> {"ok":true}
```

Full walkthrough — DNS, TLS, federation, bring-your-own-proxy, backups, upgrades,
account recovery — in [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md). To build
the server from source instead of pulling, add the
`docker-compose.build.yml` override.

## Decisions

The four locked decisions for this rebuild live in
[`docs/REBUILD.md`](docs/REBUILD.md): identity (open/self-hosted/E2E/federatable,
bridges are v2), lift-the-jewels (reuse the legacy MLS core), community-first
(self-hostable + federatable day one), and the stack (Rust/axum server, Flutter
client, Postgres-only + PostGIS-ready).
