# FABLE-BRIEF — N1.4: Doorman Edge + Agent (harness rewrite, Phase 1)

> **Node class: MERGE/HARDEN per the DAG — but EFFECTIVELY GREENFIELD ON THIS HOST.**
> The existing phase-1/phase-2 work lives ONLY on GitHub branches of `PetalNet/doorman`,
> there is no local checkout anywhere on .14, and GitHub does not resolve from this host
> (verified 2026-07-09 and again for this brief). **LAUNCHER PREREQUISITE: place a checkout
> of PetalNet/doorman (branches `phase-1-foundation` + `phase-2`) at
> `/home/docker/doorman` before firing this brief.** If fired without it, the burn falls
> back to greenfield-from-spec (§Fallback below) — legal but wasteful if the branches
> already implement half of it.
>
> **Parker input needed (can be answered async, doesn't block start): Noise NK vs XK.**
> The design gallery doc says NK; the DAG plan + N0.1 LOCKED say XK. Contracts open
> question #1. Default for this burn: **XK** (authenticates the agent's static key to the
> edge — what per-agent identity wants); log it and isolate the handshake choice behind one
> module so a flip to NK is a small diff.
>
> **Build weight: HEAVY** — tokio/hyper/axum/rustls/tokio-tungstenite/yamux/snow is a big
> cold compile. Budget it; cap parallelism. Crates.io access may be needed for new deps —
> if the registry is unreachable from .14, this node CANNOT build tonight and must be run
> on a host with egress (flag to launcher).

## §0 — How to work (fully autonomous, unattended, no human mid-run)

- You are **Fable**, running alone. Brief = source of truth. Pick-and-log free choices into
  `DECISIONS-N1.4.md` in the doorman repo root on your branch; never block.
- Repo: `/home/docker/doorman` (launcher-provided) — new branch **`feat/N1.4-edge-agent`**
  from the most advanced phase branch. Fallback repo if absent: create
  `/home/docker/doorman-greenfield` as a fresh `git init` (its whole existence is the
  reviewable artifact). Commit locally per phase; do NOT push; no PR.
- **REVIEWABLE-ONLY**: no live deploys. Do NOT touch Caddy config on The I HOP, do NOT open
  listeners on public interfaces, do NOT register anything against the live Matrix
  homeserver. Local runtime testing = loopback only (edge + agent on 127.0.0.1, self-signed
  TLS or plain TCP under test harness).
- **Build budget:** `CARGO_BUILD_JOBS=2`, `nice -n19`, one cold build is unavoidable —
  schedule it early and reuse `target/` after. No nix, no docker builds.

## Mission

Deliver the reviewable doorman core: **`doorman-edge`** (VPS side: accepts wss upgrades
behind Caddy, Noise handshake, agent registry pubkey→slot→conns, yamux demux, routes
manager→agent RPC) and **`doormand`** (agent side: 2 warm outbound wss dials, Noise auth,
yamux, heartbeat, exponential backoff + jitter, app-level session resume, Matrix-floor
trigger hook), speaking the N0.1 `backchannel-rpc` envelope end-to-end, proven by a
loopback integration test that survives a killed connection without losing an in-flight
RPC (idempotent retry).

## LOCKED decisions (do not relitigate)

- **Doorman is the SOLE backchannel. No Cloudflare, not even optional.** wss/443 is the
  mandatory floor transport; QUIC is an OPTIONAL opportunistic fast-path with automatic
  wss fallback (do NOT build QUIC in this burn — stub the probe interface; log it).
- Edge terminates behind Caddy on The I HOP (Caddy owns TLS/443 and reverse-proxies the
  WS upgrade to doorman-edge on localhost). doorman-edge itself never owns 443.
- Auth = per-agent static Noise keypairs INSIDE the TLS tunnel (private key never leaves
  the agent) + short-lived one-time enrollment token for bootstrap. Do NOT cert-pin TLS —
  validate against the system store (corporate MITM survivability; inner Noise keeps E2E
  auth). Handshake pattern default XK (see header).
- Resilience is built, not assumed: app-level session resume (session token; edge
  re-attaches a redialing agent to its slot; in-flight RPCs retried idempotently BY THE
  CALLER on the envelope `id`), 2 warm conns, heartbeat 15–20s, backoff base 1s cap ~30s
  WITH jitter — audit every reconnect path for tight loops (cloudflared and Tailscale both
  shipped that bug).
- The RPC envelope is EXACTLY
  `/home/docker/janet-manager/docs/contracts/schemas/backchannel-rpc.schema.json` — no
  transport/auth/resume fields inside it (those are transport-layer), so the identical
  envelope can ride the Matrix never-dark floor. Matrix-floor itself: interface + trigger
  only in this burn (the decision "doorman owns the fallback"), not the Matrix client.
- Manager/tasks stay on the private LAN with no public listener — they reach agents
  through the edge.
- Cross-platform: Windows first-class for doormand. rustls + rustls-native-certs (system
  store on Win/Mac/Linux). No Nix assumption for agents.
- Vendor patterns, not stale repos: transport plumbing patterns from wstunnel (BSD-3),
  Noise from snow/snowstorm (rathole pattern, Apache-2.0), yamux-rs, tokio+hyper/axum edge.

## Read first (ground truth)

- Local checkout (launcher-provided) — whatever `phase-1-foundation`/`phase-2` already
  contain: inventory it FIRST and diff against this brief's deliverables; harden/extend,
  don't rewrite.
- Design doc: gallery artifact `fleet-doorman-tunnel-design` — read via
  `sqlite3 /home/docker/tasks/data/tasks.db "SELECT content FROM artifacts WHERE slug='fleet-doorman-tunnel-design'"`.
- Contracts: `/home/docker/janet-manager/docs/contracts/CONTRACTS.md` §6 +
  `schemas/backchannel-rpc.schema.json` (+ `docs/contracts/DECISIONS.md` D20–D23 and open
  question #1).
- Fleet spec v2 §6–7 (1:1 star rooms, edge posture):
  `sqlite3 .../tasks.db "SELECT content FROM artifacts WHERE slug='fleet-manager-spec'"`.

## Deliverables (reviewable branch, local commits only)

1. **Envelope crate** (`doorman-proto` or similar): serde types for the RPC envelope,
   round-trip + conformance tests against the JSON Schema's canonical/negative examples
   (mirror the instances in janet-manager `docs/contracts/validate.py`).
2. **doorman-edge**: wss upgrade acceptance (behind an assumed reverse proxy — plain HTTP
   listener on localhost is fine), Noise responder handshake, enrollment-token bootstrap
   path, agent registry (pubkey → slot → live conns), yamux server side, request routing
   manager→agent with response correlation, session-resume slot re-attach.
3. **doormand**: config (edge URL, keypair path, agent handle), 2 warm dials, Noise
   initiator, yamux client, heartbeat, backoff+jitter with a tight-loop guard test,
   session resume on redial, idempotent-retry client helper keyed on envelope `id`,
   Matrix-floor trigger interface (trait + no-op impl).
4. **Loopback integration test**: edge + agent in-process or two processes on 127.0.0.1;
   prove (a) RPC round-trip, (b) kill one conn mid-request → retry on the second/redialed
   conn delivers exactly-once at the handler (dedup on id), (c) heartbeat keeps the slot
   alive, (d) backoff caps and jitters.
5. **Enrollment + key handling doc** (`docs/enrollment.md`): one-time token flow, key
   storage paths per OS, what the edge persists.
6. `DECISIONS-N1.4.md` — inventory of what the phase branches already had, every choice
   (incl. XK default), §0 compliance, build log, what needs a real-VPS staging pass.

## Fallback (repo absent at fire time)

Same deliverables, fresh `git init` at `/home/docker/doorman-greenfield`, and item 6 gains
a prominent "MERGE RISK: built blind to the GitHub phase branches — reconcile before any
deploy" banner.

## Phased order

1. Inventory existing branch code (or declare fallback); findings → DECISIONS; commit.
2. Envelope crate + conformance tests; commit.
3. doormand core (dial/auth/mux/heartbeat/backoff); commit.
4. doorman-edge core (accept/auth/registry/route); commit.
5. Session resume + idempotent retry + loopback integration test; commit.
6. Docs + final DECISIONS + staging checklist; commit.

## Stack / constraints

Rust, tokio, tokio-tungstenite (or fastwebsockets), rustls + rustls-native-certs, yamux,
snow/snowstorm, hyper/axum (edge). NO quinn/QUIC this burn. Static-linkable for the agent
binary. If any of these crates are missing from the local cargo cache and the registry is
unreachable, STOP that component, build what compiles offline, and log the exact missing
deps for the launcher — do not substitute exotic alternatives just because they're cached.
