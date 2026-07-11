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

```sh
cp .env.example .env
# Edit .env and set a strong JWT_SECRET (32+ random chars), e.g.:
#   openssl rand -hex 32
docker compose up
```

The server listens on `:8330` (plain HTTP; put Traefik or another reverse proxy
in front to terminate TLS). Health check:

```sh
curl http://localhost:8330/health   # -> {"ok":true}
```

## Decisions

The four locked decisions for this rebuild live in
[`docs/REBUILD.md`](docs/REBUILD.md): identity (open/self-hosted/E2E/federatable,
bridges are v2), lift-the-jewels (reuse the legacy MLS core), community-first
(self-hostable + federatable day one), and the stack (Rust/axum server, Flutter
client, Postgres-only + PostGIS-ready).
