# Point rebuild — locked decisions

These are the decisions that frame the Point rebuild. They are settled; changing
one is a new decision, not a tweak.

## 1. Identity

Point is an **open, self-hosted, end-to-end-encrypted, federatable
location-sharing network** — "Matrix for location." Encryption uses **MLS**
(Messaging Layer Security) via the lifted `core` crate (OpenMLS). Bridges to
proprietary networks (Apple Find My, Google, Samsung SmartThings) are **v2 —
explicitly not now**.

## 2. Greenfield, but lift the jewels

The rebuild is greenfield **except** for the crypto core: the legacy
`point-core` OpenMLS crate is **reused as-is** (copied into `core/`). It is
battle-tested and there is no reason to rewrite it. Extend it; don't rewrite it.

## 3. Community-first

**Self-hostable and federatable from day one.** Anyone can run a Point
home-server and federate with others. The project is licensed AGPL-3.0 to keep
self-hosted deployments and forks open.

## 4. Stack

- **Server:** Rust with **axum**.
- **Client:** **Flutter** (rebuild is a later wayfinder ticket).
- **Database:** **Postgres only**, via `docker-compose`, **PostGIS-ready**.
- **TLS:** terminated by Traefik in front of the server; the binary speaks plain
  HTTP (no in-binary TLS).
