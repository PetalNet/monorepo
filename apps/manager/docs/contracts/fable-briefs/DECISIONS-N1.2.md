# N1.2 tmux Layer — DECISIONS log

Brief: `FABLE-BRIEF-N1.2-tmux-layer.md` (this directory), as amended by the
2026-07-11 update directive (build-for-real: monorepo target, real PR + CI,
container-tested, adversarial + codex review, self-merge after gates).

## M0 — Re-plan against the updated directive

### Ground truth confirmed

- The tmux layer lives at **`apps/manager/src/tmux.rs`** in the monorepo
  (the directive's `apps/manager/manager-rs/src/tmux.rs` path is the
  pre-migration layout; N1.1's migration flattened `manager-rs/` into the
  app root — `src/`, `Cargo.toml` at `apps/manager/`).
- Call sites audited: `supervisor.rs` (spawn/adopt/liveness/kill/auto-accept),
  `health.rs` (`pane_alive` as a health assert). Heartbeat exposes
  `tmux_session` + `pane_id` per CONTRACTS.md §2 (nullable, non-tmux
  platforms skip the pane assert).
- fleet-term consumer (ground truth for the host spec):
  `/home/docker/tasks/fleet-term/Dockerfile` +
  `docker-compose.fleet-term.yml` — ttyd 1.7.7 (sha-pinned) in Alpine,
  runs uid 1000, attaches to the HOST socket `/tmp/tmux-1000/default`
  (bind-mounted `/tmp/tmux-1000`), `attach -r -t janet-claude` (ro) and
  `attach -t janet-claude` (rw), tasks-network-only.
- Host tooling: tmux 3.6a (nix profile) for scratch-server tests; docker
  29.x; cargo/rustc 1.96.0 = the `rust-toolchain.toml` pin; `gh` CLI
  present (N1.1 lacked it); push auth via PAT already embedded in the
  staged checkout's remote.
- Monorepo CI (`.github/workflows/ci.yml`) has **no Rust job** — N1.1's
  logged convention is that Rust validation stays Cargo-native (host +
  container runs), with the JS-side jobs (check/build/typos/link-check)
  as the CI gate. Kept as-is; see Open questions.

### Plan (phases, each a commit)

1. **M1 — as-is failure-mode table** (below) + this plan. Commit.
2. **M2 — integration tests** `apps/manager/tests/tmux_it.rs`,
   `#[ignore]`-gated AND env-gated (`N12_TMUX_IT=1`), each test on its own
   scratch socket `n12test-<pid>-<test>` (private socket namespace per the
   brief; per-test suffix so parallel tests never share a server). A Drop
   guard kills the scratch server on every exit path including panics.
   Coverage: spawn+tag+find-among-decoys, pane_alive true→kill→false,
   send_keys/capture round-trip, untagged pane never matches, second
   manager tag no collision, tag-clobber ⇒ pane treated dead, exact-name
   (`=`) targeting vs prefix match, server-down / session-gone / pane-gone
   behavior of every public fn. NEVER the default socket; the live
   `janet-claude` session is never touched.
3. **M3 — hardening** only where the tests expose gaps (expected: stderr
   is currently discarded — error strings can't distinguish "binary
   missing" / "server down" / "session gone"; `capture` can't distinguish
   error from empty pane). Public fn signatures stay; call sites stay.
   Every public fn gets doc comments stating its behavior per failure mode.
4. **M4 — declarative host spec** `apps/manager/docs/tmux-host-config.md`
   + `apps/manager/docs/tmux.conf.reviewable` (+ ttyd module spec in the
   same doc), pinned tmux version, the options the harness relies on, the
   fleet-term socket contract. Marked NOT APPLIED / spec-only.
5. **M5 — container validation**: `rust:1.96-slim` + pinned tmux from
   Debian (version logged), `--cpus=2`, `CARGO_BUILD_JOBS=2`, source
   mounted read-only, CARGO_HOME/target inside the container;
   fmt --check, clippy -D warnings, `cargo test --locked` including
   `N12_TMUX_IT=1 cargo test -- --ignored` (tmux server inside the
   container — fully isolated from the host). Loop until green.
6. **M6 — reviews + PR**: push branch, open PR, adversarial review
   subagent (facade/fake-green, races, failure-mode gaps, spec drift) +
   codex review (`/usr/bin/codex`, best available model — gpt-5.6 is
   rejected on this account; use gpt-5.5 high and log it). Address
   findings, re-run container tests if code changed, self-merge (standard
   merge, history-preserving) only after CI green + both reviews
   addressed. Log everything here.

### §0 compliance

- All tmux integration tests run on private `-L n12test-*` sockets
  (`/tmp/tmux-1000/n12test-*`), never the default socket
  (`/tmp/tmux-1000/default`) that carries the live `janet-claude`
  session. Only scratch servers are killed, by their exact socket name.
- Builds: `CARGO_BUILD_JOBS=2`, `nice -n19`; load checked before builds
  (0.50 on 8 cores at start; Point is co-building on this host — will
  gauge before each heavy step and stagger).
- No nix builds, no service restarts, no live config changes. The nix
  half is spec-only files under `apps/manager/docs/`.

### M0 decisions

| #  | Decision | Rationale |
|----|----------|-----------|
| D1 | Test target path is `apps/manager/tests/tmux_it.rs` (not `manager-rs/tests/`) | post-migration layout; directive's path is stale, confirmed by tree + N1.1 log |
| D2 | Add an optional private socket field to `Tmux` (constructor `Tmux::new` unchanged, extra constructor for tests) | the struct hardcodes the default server; integration tests MUST point it at the scratch socket. Additive; zero call-site changes — the brief's "no API redesign" holds |
| D3 | Per-test scratch sockets `n12test-<pid>-<label>` instead of one shared `n12test` | cargo runs tests in parallel threads; a shared server would cross-couple tests and a shared kill would race. Still inside the brief's private-socket namespace |
| D4 | Tests double-gated: `#[ignore]` + skip-unless `N12_TMUX_IT=1` | brief requires CI-less runs stay green; plain `cargo test` never spawns tmux servers |
| D5 | No Rust job added to monorepo CI | N1.1's logged convention (Cargo-native validation, container proof); adding CI infra is out of scope for a LIGHT node — flagged in Open questions instead |
| D6 | Host spec pins tmux **3.4** (what the live host runs per the brief) even though this dev host has 3.6a | the spec describes the LIVE host contract; 3.4 satisfies the ≥3.0 user-option requirement |

## M1 — as-is failure-mode behavior (before hardening)

Enumerated by reading `run()` + each public fn; verified by the M2 tests.
`run()` shells out to `tmux`, returns `(exit_code, stdout)`; **stderr is
discarded** (printed nowhere), exec failure ⇒ `(-1, "")` + one eprintln.

| Failure mode | session_alive | panes / find_tagged_pane | pane_alive | tag_pane | new_session_with_cmd | new_window_with_cmd | send_keys | capture | kill_pane |
|---|---|---|---|---|---|---|---|---|---|
| tmux binary missing | false | empty / None | false | false | Err (code -1, empty out) | Err (code -1) | false | `""` | false |
| server not running | false | empty / None | false | false | **Ok — starts the server** (correct) | Err (code 1) | false | `""` | false |
| session gone (server up) | false | empty / None | false | false | Ok (recreates) | Err | false | `""` | false |
| pane gone (session up) | true | listed w/o our pane / None | false | false | Err (duplicate session) | Ok | false | `""` | false |
| tag clobbered (other value) | true | listed, foreign tag / None | **false** (by design: id AND tag) | true (would re-clobber) | — | — | true | works | true |
| tmux < 3.0 (no user options) | true | tag column empty | false | **false ⇒ spawn-fail path** (locked: failed spawn, not degraded) | Ok | Ok | true | works | true |

Gaps this table exposes (candidates for M3, pending test confirmation):

- G1: all error paths are silent to the caller beyond `false`/`Err(code)`;
  stderr (which distinguishes `no server running`, `can't find session`,
  `can't find pane`) is thrown away. Supervisor logs "SPAWN FAILED (code 1,
  out \"\")" with no cause.
- G2: `capture()` returns `""` both for a dead pane and an empty pane —
  callers cannot tell. Sole caller (auto-accept) is safe because it gates
  on `pane_alive` first; must be documented as a contract.
- G3: no fn documents its per-failure-mode behavior; the table above was
  archaeology. Doc comments required (brief deliverable 2).
