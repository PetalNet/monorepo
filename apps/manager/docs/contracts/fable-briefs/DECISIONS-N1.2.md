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
   - `apps/manager/docs/tmux.conf.reviewable` (+ ttyd module spec in the
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

| #   | Decision                                                                                                        | Rationale                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Test target path is `apps/manager/tests/tmux_it.rs` (not `manager-rs/tests/`)                                   | post-migration layout; directive's path is stale, confirmed by tree + N1.1 log                                                                                         |
| D2  | Add an optional private socket field to `Tmux` (constructor `Tmux::new` unchanged, extra constructor for tests) | the struct hardcodes the default server; integration tests MUST point it at the scratch socket. Additive; zero call-site changes — the brief's "no API redesign" holds |
| D3  | Per-test scratch sockets `n12test-<pid>-<label>` instead of one shared `n12test`                                | cargo runs tests in parallel threads; a shared server would cross-couple tests and a shared kill would race. Still inside the brief's private-socket namespace         |
| D4  | Tests double-gated: `#[ignore]` + skip-unless `N12_TMUX_IT=1`                                                   | brief requires CI-less runs stay green; plain `cargo test` never spawns tmux servers                                                                                   |
| D5  | No Rust job added to monorepo CI                                                                                | N1.1's logged convention (Cargo-native validation, container proof); adding CI infra is out of scope for a LIGHT node — flagged in Open questions instead              |
| D6  | Host spec pins tmux **3.4** (what the live host runs per the brief) even though this dev host has 3.6a          | the spec describes the LIVE host contract; 3.4 satisfies the ≥3.0 user-option requirement                                                                              |

## M1 — as-is failure-mode behavior (before hardening)

Enumerated by reading `run()` + each public fn; verified by the M2 tests.
`run()` shells out to `tmux`, returns `(exit_code, stdout)`; **stderr is
discarded** (printed nowhere), exec failure ⇒ `(-1, "")` + one eprintln.

| Failure mode                 | session_alive | panes / find_tagged_pane   | pane_alive                        | tag_pane                                                         | new_session_with_cmd                 | new_window_with_cmd | send_keys | capture | kill_pane |
| ---------------------------- | ------------- | -------------------------- | --------------------------------- | ---------------------------------------------------------------- | ------------------------------------ | ------------------- | --------- | ------- | --------- |
| tmux binary missing          | false         | empty / None               | false                             | false                                                            | Err (code -1, empty out)             | Err (code -1)       | false     | `""`    | false     |
| server not running           | false         | empty / None               | false                             | false                                                            | **Ok — starts the server** (correct) | Err (code 1)        | false     | `""`    | false     |
| session gone (server up)     | false         | empty / None               | false                             | false                                                            | Ok (recreates)                       | Err                 | false     | `""`    | false     |
| pane gone (session up)       | true          | listed w/o our pane / None | false                             | false                                                            | Err (duplicate session)              | Ok                  | false     | `""`    | false     |
| tag clobbered (other value)  | true          | listed, foreign tag / None | **false** (by design: id AND tag) | true (would re-clobber)                                          | —                                    | —                   | true      | works   | true      |
| tmux < 3.0 (no user options) | true          | tag column empty           | false                             | **false ⇒ spawn-fail path** (locked: failed spawn, not degraded) | Ok                                   | Ok                  | true      | works   | true      |

This table predates the M3/M6 hardening (tag_pane now returns a
classified `Result`, kill_pane has an ownership guard). The `tmux < 3.0`
row is asserted by design, not executed — no pre-3.0 binary exists
anywhere in the fleet to test against (M6/A3). All other rows are
exercised by the M2 tests.

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

## M2 — integration tests (+ one fix the tests forced)

10 tests in `apps/manager/tests/tmux_it.rs`, double-gated (`#[ignore]` +
`N12_TMUX_IT=1`), one scratch server per test (`-L n12test-<pid>-<label>`),
Drop-guard cleanup verified by a dedicated test (killing one scratch server
leaves a sibling running; nothing leaks after the suite — checked by
enumerating `/tmp/tmux-1000/n12test-*` post-run). Coverage: decoy panes
(untagged, foreign-tag, extra window), kill→dead→session-death, send/capture
round-trip (arithmetic-expansion trick so captured _output_ is proven, not
echoed input), untagged never matches, two managers in one session don't
collide, tag clobber ⇒ treated dead ⇒ re-tag restores, exact-name targeting,
server-down matrix, session-up/pane-gone matrix.

### Finding F1 (real bug, fixed): `=session` still prefix-matches outside has-session

Observed on tmux 3.6a while writing the exact-name test: with only
`n12it-longer` alive, `has-session -t '=n12it'` correctly fails, **but
`list-panes -s -t '=n12it'` lists the longer session's panes and
`new-window -t '=n12it'` creates a window IN the longer session** (exit 0).
The `=` exact guard the header comment relies on only holds in
target-session positions; in target-window/pane positions tmux falls back
to prefix matching. Worst production case: exact session dead but e.g.
`janet-claude-experiments` alive ⇒ the manager could list/adopt a pane in,
or spawn the agent into, a stranger's session. Fix (one line, inside the
layer, no call-site change): `starget()` now yields `=<session>:` — the
trailing `:` pins target-window/pane resolution to the exact session in
every command; verified for `has-session`, `list-panes -s`, `new-window`
on 3.6a, and by the (previously red) exact-name test. Folded into the M2
commit so no commit on the branch carries a red test.

### M2 decisions

| #   | Decision                                                                                    | Rationale                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D7  | Test file includes the module via `#[path = "../src/tmux.rs"]`                              | the crate is bin-only; integration tests can't link a bin. Alternatives: lib+bin split (crate restructure — over-building a LIGHT node) vs path-include (zero production change, same source compiled). Chose path-include; revisit if a later node needs a lib target |
| D8  | Raw test-side tmux calls also use `=<session>:` targets                                     | same exact-match discipline as the layer; a bare `=name` pane-target is rejected by tmux 3.6a (`can't find pane`)                                                                                                                                                      |
| D9  | `#[allow(dead_code)]` on `with_socket` (bin never calls it) and on the included test module | keeps `clippy -D warnings` green on both targets without loosening crate-wide lints                                                                                                                                                                                    |

## M3 — failure-mode hardening

Scope held to the gaps M1/M2 exposed; no signatures, no call-site changes.

- G1 closed: `run()` captures stderr (`Exec {code, out, err}`);
  `new_session_with_cmd` / `new_window_with_cmd` errors now name the
  distinguished cause via `describe_failure()` — binary missing (exec
  error), server not running (`no server running` / `error connecting to`
  — the latter is what 3.6a actually emits for a dead private socket;
  caught by the server-down test), session/pane not found, other (exit
  code + stderr). The supervisor's existing "SPAWN FAILED: {e}" log line
  now carries the cause with zero supervisor changes.
- G2 documented as contract: `capture()` returns `""` for dead AND blank
  panes; callers gate on `pane_alive` (the auto-accept loop already does).
- G3 closed: every public fn's doc comment states behavior per failure
  mode; module header gained a "Failure modes (contract)" section.
- Two integration tests strengthened to assert the classified messages
  (server-down ⇒ "server not running"; duplicate session ⇒ tmux's
  "duplicate session" stderr preserved).
- NOT hardened (logged as out of scope): a live "tmux binary missing"
  test would need process-global PATH mutation (racy under parallel
  tests); the exec-failure branch is covered by code inspection and the
  classifier's `exec failed:` arm. tmux < 3.0 behavior is asserted by
  design (tag_pane false ⇒ spawn-fail path, unit-level) — no pre-3.0
  binary is installed anywhere in the fleet to test against.

## M4 — declarative host spec (NOT APPLIED)

`docs/tmux-host-config.md` + `docs/tmux.conf.reviewable`:

- One-version rule: host tmux pinned **3.4**, and the pin is COUPLED to
  the fleet-term container base (Alpine 3.20 ships tmux 3.4; its
  containerized client attaches to the host server socket — protocol
  mismatch breaks the web terminal). Upgrades are atomic across both.
- Conf pins `remain-on-exit off` explicitly: pane death IS the manager's
  exit detection; a convenience tweak flipping it would make crashed
  agents look alive forever. Plus the brief's trio: escape-time 10,
  aggressive-resize on, history-limit 50000; true-color + focus-events
  for the humans.
- Socket contract for N1.7: `/tmp/tmux-1000/default`, uid 1000 / 0700
  dir, session `janet-claude`, tmp-sweeper exemption requirement.
- tmux.nix content includes a build-time assertion on the 3.4 pin;
  ttyd.nix content mirrors the container pair (loopback-only, ro
  auto-start, rw opt-in), with the containerized pair staying
  authoritative until janet-nix decides otherwise.

## M5 — container validation

Gate: `rust:1.96-slim` (Debian trixie, tmux **3.5a** from apt), `--cpus=2`,
`CARGO_BUILD_JOBS=2`, source mounted read-only (copied to `/work`),
CARGO_HOME/target inside the container. Steps: fmt --check, clippy
`-D warnings`, `cargo test --locked`, `N12_TMUX_IT=1 cargo test --locked
--test tmux_it -- --ignored`, `cargo build --locked --release`.

### Finding F2 (real bug, fixed; container-only catch): tab separator dies on tmux 3.4/3.5

First container run: 5/10 integration tests red on tmux 3.5a — every
positive tag-readback failed. Root cause: `panes()` asked for
`#{pane_id}\t#{@agent_manager_owner}` and split on TAB, but tmux
sanitizes control characters in list-command output to `_`, fusing both
columns into one token (`%0_n12-mgr-primary`) — tag never matches, so
`find_tagged_pane`/`pane_alive` are ALWAYS negative. Verified matrix:

| tmux                                      | tab-separated                          | space-separated |
| ----------------------------------------- | -------------------------------------- | --------------- |
| 3.4 (Alpine 3.20 — **the live-host pin**) | BROKEN (`_` fused)                     | OK              |
| 3.5a (Debian trixie)                      | BROKEN                                 | OK              |
| 3.6a (dev host, nix)                      | works — which is why host tests passed | OK              |

**Implication worth relaying:** on the pinned live version 3.4 the old
format never read tags back — a manager on 3.4 could not adopt its pane
and its liveness poll would read its own pane as dead 5s after spawn
(kill/respawn backoff loop). The dev host's 3.6a masked this; only the
container run surfaced it. Fix: separator is now a single SPACE (pane
ids `%N` can't contain spaces; split on first space; id must start with
`%`), verified green on 3.4 / 3.5a / 3.6a. `=<session>:` exact targeting
(F1) also re-verified OK on 3.4.

Second container run: full gate green (transcript summary below).

### M5 transcript summary (final green run)

- Image `rust:1.96-slim` (rustc 1.96.1 after in-container rustup sync of
  the 1.96 pin), tmux **3.5a** (apt, Debian trixie), `--cpus=2`,
  read-only source mount.
- fmt --check: OK. clippy --all-targets --locked -D warnings: OK.
- `cargo test --locked`: 21/21 unit (10 IT correctly ignored without the
  env gate).
- `N12_TMUX_IT=1 cargo test --locked --test tmux_it -- --ignored`:
  **10/10** on the container's own tmux server (fully isolated from the
  host).
- `cargo build --locked --release`: OK (28.7s).
- Also ran under `--test-threads=1` during F2 diagnosis (same result
  pattern — F2 was not a race).
- Cross-version matrix: 3.4 via `alpine:3.20` (CLI-level: space format +
  `=name:` verified), 3.5a full suite, 3.6a full suite on host.
- §0: host load gauged before each container run (≤1.5 on 8 cores);
  builds capped at 2 jobs / 2 cpus, nice -n19 on host runs.

## M6 — reviews, PR #94, and the review-driven fix cycle

PR: PetalNet/monorepo#94. CI was green pre-review (11 checks, incl.
CodeQL; the only failure ever was `vp fmt` on two new markdown files).

### Reviews run

- **codex** (`/usr/bin/codex exec`, model **gpt-5.5, reasoning=high** —
  this account rejects gpt-5.6, as the directive predicted). First
  attempt could not read anything: codex's bubblewrap sandbox cannot
  create user namespaces on this host (`bwrap: loopback: Failed
RTM_NEWADDR`) and it correctly refused to invent findings. Re-ran with
  the full diff + post-change tmux.rs + unchanged supervisor.rs/health.rs
  piped via stdin, shell forbidden. 7 findings.
- **Adversarial subagent** over the branch (read-only; own `n12adv-*`
  scratch sockets, cleaned). 10 findings + a "checked, fine" list that
  independently re-verified F1 empirically and confirmed no drift vs the
  fleet-term consumer contract.

### Findings → responses (fixes are in the "review: ..." commit)

| #     | Finding                                                                                                            | Response                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1/C2 | send_keys/capture trust a raw pane id (id reuse across server restarts)                                            | Documented as an explicit caveat on both fns + module header; both callers gate on pane_alive (verified). No recheck inside: ms-level TOCTOU remains regardless, and the accepter polls 1s                                                                                |
| C3    | kill_pane destructive with a stale id                                                                              | **Fixed**: kill guard — id must be listed in OUR exact session with our tag or no tag (untagged allowed so failed-tag spawn cleanup still works). Residuals documented. Tests: refuses foreign-tagged + unknown id, still kills untagged in-session                       |
| C4    | supervisor collapses transient tmux failure into "crash"                                                           | No change; the design self-heals — respawn begins with find_tagged_pane, which re-adopts the still-live pane once tmux recovers (adversarial review independently confirmed). Cost: one crash count + one message. Logged below as an open question for a supervisor node |
| C5    | exact-name test wouldn't catch a starget() revert                                                                  | Moot: a revert makes `short.panes()` non-empty on 3.5/3.6 and the existing assert fails; bare-`-t` prefix hazard is asserted. Strengthened anyway: new_window error must name "session not found" (also covers A7)                                                        |
| C6    | one-version doc overstated client/server lockstep                                                                  | **Fixed**: reworded — historical hard failures + behavior skew (F2!) justify the single pin; manager CLI tolerance 3.4–3.6 stated                                                                                                                                         |
| C7    | "error connecting to" over-classified as server-not-running                                                        | **Fixed**: message now names socket path/permission as a possible cause; test updated                                                                                                                                                                                     |
| A1    | tag_pane discards the classified cause — a fast-dying agent was misreported as "tmux >= 3.0 required", every retry | **Fixed** (bug-forced call-site change, per brief rule): `tag_pane -> Result<(), String>` with describe_failure(); supervisor logs+sends the real cause. New IT: tag after instant pane death names a real cause                                                          |
| A2a   | no Rust job in monorepo CI — "CI green" proved nothing about this branch                                           | **Fixed**: added `manager-rust` CI job (fmt, clippy -D warnings, unit tests, N12_TMUX_IT=1 integration tests on the runner's tmux; ubuntu-latest ships tmux 3.4 — the live pin — so the suite now runs on 3.4 in CI, closing A8c too). Supersedes decision D5             |
| A2b   | `--ignored` without the env var silently reported 10 green no-op tests                                             | **Fixed**: require_it! now FAILS loudly; plain `cargo test` still never spawns tmux (`#[ignore]`)                                                                                                                                                                         |
| A2c   | DECISIONS referenced an "Open questions" section that didn't exist                                                 | **Fixed**: section added below                                                                                                                                                                                                                                            |
| A3    | tmux < 3.0 behavior stated as tested contract but never executed                                                   | **Fixed** (honesty over coverage): module header + M1 table now mark the < 3.0 rows "asserted by design, not executed — no pre-3.0 binary exists in the fleet". Not adding a 2.x container to a LIGHT node                                                                |
| A4    | clobbered tag ⇒ duplicate agent on one session id; clean_stale_session_locks removes the live agent's lock         | Documented as a known limitation (open question below). The locked design ("not provably ours ⇒ respawn") accepts this; requires a hostile/buggy actor with tmux access                                                                                                   |
| A5    | kill_pane false conflates "already dead" with "unreachable"; graceful_shutdown ignored it                          | **Fixed**: doc states both meanings; graceful_shutdown now logs a WARN when the kill cannot be confirmed (the one path with no self-heal)                                                                                                                                 |
| A6    | code comment said tab sanitization is ">= 3.5" but 3.4 (the live pin) is affected                                  | **Fixed**: comment now says 3.4 AND 3.5, names 3.6a as the masking version                                                                                                                                                                                                |
| A7    | describe_failure: 3 of 5 arms untested                                                                             | **Fixed**: pure unit test in tmux.rs covers every arm incl. exec-failure (no PATH mutation needed); exact-name IT asserts the session-not-found arm end-to-end                                                                                                            |
| A8    | container gate + leak check not reproducible from the repo; "verified green on 3.4" overstated                     | **Fixed**: `scripts/container-validate.sh` committed (the exact M5 gate); F2 wording corrected below; leak check acknowledged as a manual step. The new CI job runs the full suite on 3.4 mechanically                                                                    |
| A9    | spawn-path log claimed "(none ours)" — TOCTOU-stale                                                                | **Fixed**: log reworded to what is actually known                                                                                                                                                                                                                         |
| A10   | adopt path spawns no auto-accept thread (agent adopted mid-prompt hangs)                                           | Pre-existing supervisor behavior, out of N1.2 scope; open question below                                                                                                                                                                                                  |

**Correction to M5/F2 wording** (per A8c): 3.4 was verified at the tmux
CLI level (space format + `=name:` exact targeting, via alpine:3.20)
during this run — the full Rust suite ran on 3.5a (container) and 3.6a
(host). With the new CI job the full suite now also runs on ubuntu's
tmux 3.4 on every PR.

### Open questions (for Janet / later nodes)

1. **Supervisor liveness robustness** (C4): one transient tmux CLI
   failure marks the agent crashed (self-heals via adopt, but costs a
   crash count + Matrix noise). A retry-once-before-declaring-dead in
   poll_liveness would remove the noise. Supervisor node scope.
2. **Clobbered-tag duplicate agent** (A4): if something overwrites our
   pane tag, the old agent keeps running and we respawn a second one on
   the same session id (and clean_stale_session_locks deletes the live
   agent's lock on the way). Accepting for now — requires tmux-level
   interference inside the trust boundary. Worth a supervisor-level
   guard (e.g. compare pane PID trees) only if it ever actually happens.
3. **Adopt path never auto-accepts** (A10): a manager restart that
   adopts an agent still sitting at a startup prompt leaves the prompt
   unanswered. Supervisor node scope.
4. **tmux < 3.0 rows remain asserted-not-executed** (A3): acceptable
   while nothing in the fleet runs pre-3.0; revisit only if that changes.
5. **Rust CI job scope**: manager-rust runs on every PR (no path
   filter), matching how the other jobs behave. If monorepo CI time ever
   matters, add path filters repo-wide in one pass.
