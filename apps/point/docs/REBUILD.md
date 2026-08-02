# Point rebuild — completed framing

**Status: completed.** The Rust server/core and Flutter client described here are
implemented. This short record preserves the rebuild's framing; current behavior
is defined by manifests, source, tests, and the later entries in
[`../DECISIONS.md`](../DECISIONS.md).

## 1. Identity

Point is an **open, self-hosted, end-to-end-encrypted, federatable
location-sharing network** — "Matrix for location." Encryption uses **MLS**
(Messaging Layer Security) via the lifted `core` crate (OpenMLS). Bridges to
proprietary networks (Apple Find My, Google, Samsung SmartThings) are **v2 —
explicitly not now**.

## 2. Greenfield, but lift the jewels

The rebuild was greenfield **except** for the crypto core: the legacy
`point-core` OpenMLS crate was copied into `core/` and subsequently extended.

## 3. Community-first

**Self-hostable and federatable from day one.** Anyone can run a Point
home-server and federate with others. The project is licensed AGPL-3.0 to keep
self-hosted deployments and forks open.

## 4. Stack

- **Server:** Rust with **axum**.
- **Client:** implemented in **Flutter**, with a Rust bridge in `app/rust/`.
- **Database:** **Postgres only**, via `docker-compose`, **PostGIS-ready**.
- **TLS:** terminated by Traefik in front of the server; the binary speaks plain
  HTTP (no in-binary TLS).
