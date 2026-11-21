# Janet voice head

The voice head answers spoken turns for a voice client and keeps a long-running Claude
Code session ("main") informed of what was said. A client (the desk client, later a
phone line) sends text it transcribed and speaks the sentences it gets back. The design
is in [docs/janet-voice/SPEC.md](../../docs/janet-voice/SPEC.md), §9 and §10.

Personal claims in greetings and conversation must come from the caller, inherited
context, or tool results. The shared prompt rule covers plain, web, lab, and cold heads.

Run the manual grounding eval against real Claude models from the repository root:

```sh
python3 apps/janet-voice-head/scripts/eval_grounding.py --model sonnet --judge-model sonnet --output /tmp/voice-grounding.json
```

It opens seven fresh, temporary sessions using the production session wrapper, prompt
builder, and tool boundaries, with synthetic personal context. Matrix history is
unavailable in the fixtures. A separate judge checks unsupported claims and two controls
that require using supplied facts; judge calibration must reject invented history and
evasion while accepting a factual greeting. Model errors, missing verdicts, and failed
calibration fail the run. It makes eight model sessions, uses no live personal history,
and does not run in the unit suite. Results include replies, verdicts, model names, CLI
version, and the prompt source hash. This small stochastic eval cannot guarantee that
the model never fabricates or reproduce every inherited conversation; use `desk-test`
for deployed checks that must not merge into main Janet.

One conversation is one voice Claude Code process:

- **Fork at wake.** `POST /v1/conversations` starts `claude --resume <main> --fork-session`
  the moment the wake word fires. The process loads main's transcript, so the head knows
  everything main knew at that second. It then makes one warm-up model call ("reply
  ready", never spoken) while the speaker is still talking: a fork's first call reads all
  of main's context uncached and took 7 to 25 s, and every later turn took about 2 s. A
  turn that arrives during the warm-up waits for it. `warm_up = false` turns it off. Only
  personal forks are warmed, and nothing calls a model for a conversation nobody opened.
- **Trimmed resume.** Main's transcript is gigabytes, but the model only sees what follows its last
  compaction. The head copies that part (from the last `compact_boundary` record on, uuid chain
  intact, plus the records the compaction kept from before it: `preservedSegment`) to a new session file and resumes the copy, so a fork starts in 0.9 s instead of 3.3 s.
  Without a boundary in the last 64 MB it resumes main's file as before. `trim_transcript = false`
  turns it off. `trim_reuse_s` (default 0, a fresh copy per conversation) lets forks that open
  within that many seconds share one copy, and so share the model's prompt cache: a cached first
  call read 184k tokens and reached the first token in 3.8 s, against 6.5 s uncached, at the price
  of a fork that is that much staler than main.
- **Main-like fork and the cache splice (off by default).** A fork reads main's prompt cache only when the start of its
  request matches main's byte for byte, and a fork resumed from main's transcript does not: headless mode words a few
  tool definitions differently, and some old messages are rendered from session state main has and the fork lacks (a
  harness-tag line in an attachment, a string where main sent a text block). The first difference makes it rebuild
  everything after it: 14k tokens read and 162k written on a 160k-token fork. With `main_like_fork = true` a personal
  fork is launched as main is (main's plugins and tool set from `main_like_args` and `main_like_env`, main's directory)
  with `--permission-mode dontAsk` and no settings files, so no allow rule can run a tool. Plugin hooks still run and
  read-only tools are still allowed: deny them with `permissions.deny` in a `--settings` file in `main_like_args`.
  With `cache_splice = true` (the default) the head also runs a loopback proxy (`cache_splice.py`) and points the fork
  at it with `ANTHROPIC_BASE_URL`. Main logs every request in its transcript, so the proxy rebuilds main's latest one,
  and for a fork request replaces the tool definitions and the first k messages, which correspond to main's after
  stripping harness-tag lines, with main's own, leaving the fork's tail as it is. It skips, forwards unchanged and logs
  `splice skipped: <why>` when main's request is older than the cache lifetime, belongs to another session, the first
  message does not correspond, or the tail would answer a tool call the prefix does not hold. Measured on a 160k-token
  fork, first call: 14,303 read and 162,156 written without it, 176,459 read and 0 written with it.
- **Call control.** Every session gets a private MCP server with `ask_to_end_call` and
  `end_call`. The first tool makes the head append a closing question. Only the immediately
  following caller turn can use `end_call`; the model decides whether the caller confirmed
  nothing else remains. Interrupted replies clear that permission. The head appends goodbye
  before signaling the client to hang up after playback. Caller speech is never phrase matched.
- **Tool boundary.** The process has an allowlisted environment and only the call-control
  MCP server by default. The head checks the session's reported tools and refuses unexpected
  tools or servers. With `web_tools` (config, default empty), a `personal` head also gets
  `WebSearch`/`WebFetch` (`--tools`, `--permission-mode dontAsk`, a `--settings` allow list).
  Setting sources stay off. Guests never get web tools. In `main_like_fork` mode the same settings are merged into the `--settings` file in `main_like_args` (Claude reads only the last `--settings`): the blanket deny of those tools is lifted, the allow rule, named-domain denies and hook are added. WebFetch is refused for
  loopback, private, link-local and tailnet addresses and for `*.petalcat.dev`, `*.ts.net`, `localhost` and
  `*.local`: Claude's `WebFetch(domain:...)` deny rules match names only (not `10.*`, checked on 2.1.326), so
  `web_guard.py` runs as a PreToolUse hook that resolves the host and checks every address. Known gap: the
  hook and the fetch resolve the name separately, so a DNS-rebinding page can still reach a private address; close it
  with egress rules on the unit if that matters. A search query or URL can also carry text out of the fork's context;
  only the prompt forbids it. A verified Parker call can also receive the fixed lab MCP allowlist
  described under "Read-only lab access on Parker's phone" below. It requires a separate credential and a lean fork.
- **Soft merge.** The model ends a reply with a `<relay>` block when the speaker asked for
  something to be done. The head strips the block from speech and injects the ask into
  main at once, so main acts during the call.
- **Hard merge, once.** When the conversation ends, the head injects one message into
  main: the transcript, a summary, and every ask marked as already relayed or new.
- **Tiers.** `personal` is the fork. `room` and `guest` are a fresh session in an empty
  directory with no memory of main. Their conversations reach main labelled as untrusted
  speech, and their asks are never relayed for action.

## API

Bearer token on every `POST` and on `GET /v1/calls`. Bodies and replies are JSON.

| Call                                    | Body                                  | Reply                              |
| :-------------------------------------- | :------------------------------------ | :--------------------------------- |
| `GET /health`                           |                                       | `{"ok": true, "version": "0.1.0"}` |
| `GET /v1/calls`                         |                                       | `{"active_calls": 0}`              |
| `POST /v1/conversations`                | `{"channel", "tier"?, "client_ref"?}` | `{"id"}`                           |
| `POST /v1/conversations/{id}/turns`     | `{"text"}`                            | `text/event-stream`                |
| `POST /v1/conversations/{id}/interrupt` | `{"heard_text"}`                      | `{"ok": true}`                     |
| `POST /v1/conversations/{id}/end`       | `{"reason"}`                          | `{"merged": true, "delivery"}`     |

- `tier` is `personal`, `room` or `guest`. A request without one gets `guest`.
- The same `client_ref` returns the same conversation, so a client can retry the call.
- A turn streams one `sentence` event (`{"text"}`) per speakable sentence, then one
  `done` event: `{"end_conversation": bool, "latency_ms": {"first_token", "first_sentence",
  "total", "spawn_wait"}}`. A turn that arrives before the session is ready waits for it.
- When the caller seems done, the model uses the call-control tools to ask whether anything
  else remains, then signs off after a later confirmation. The client drains the goodbye
  audio before calling `end`.
- `interrupt` stops a reply that is still being generated. `heard_text` is what the speaker
  heard before cutting in; the head tells the model so on the next turn and in the merge.
- `end` is idempotent. A conversation with no turn for `idle_timeout_s` ends itself, so a
  crashed client still gets its conversation merged.
- `GET /v1/calls` counts live conversations across every channel, including calls that have
  not sent a turn yet. Ending calls stop counting before their transcript merges into main.
  No conversation identifiers or transcripts are exposed.

## Release the speech GPU after calls

`tts_unload_command` is an optional fixed argument list executed after the last call ends,
including idle timeout, shutdown, startup failure, and restart recovery. A nonzero exit or
five-second timeout is retried by the two-second upkeep loop. Opening a call and submitting
an unload are serialized, so a release cannot race a new call. A second live call delays it.
The command carries no caller text. The deployed command uses SSH to request Chatterbox's
loopback-only `POST /unload`; busy synthesis returns 409 and is retried.

[`scripts/render-guard.sh`](scripts/render-guard.sh) permits renders only when this head
reports zero active calls, TTS is unloaded with no active or queued synthesis, and at least
5 GB of VRAM is free. Unavailable or invalid status pauses rendering. It reads the voice
bearer from `~/.hermes-janet/secrets/voice-head-token` and queries PC status over SSH.
`VOICE_HEAD_URL`, `VOICE_HEAD_TOKEN_FILE`, and `VOICE_TTS_SSH` override those locations.

## Exactly once

Each conversation is the fold of an append-only journal,
`<state_dir>/conversations/<id>.jsonl`. Every state change (`opened`, `exchange`,
`ending`, `hard_sending`, `merged`, `archived`) is one line, written with `fsync` before
the head acts on it. After a restart the head reads the journals, ends every conversation
that was open, and continues each one from its last line.

The head can die after main's hub accepted a merge and before the journal says `merged`.
Each message therefore carries a key (`voice-hard:<id>`, `voice-soft:<id>:<exchange>`).
Before the head sends a message a second time, it looks for the key in the hub's persisted
queue and then in the part of main's transcript written since the first attempt, and sends
only when neither holds it. A hub whose `/health` reports `inject_keys: true` drops a
repeated key itself, and the head then sends again without the lookup.

Nothing is deleted. The journal and the head session's own transcript stay on disk, and
the hard merge names both along with the parent session and the fork point.

## What main receives

- **Size.** The hub refuses text over 20000 characters, so every merge is built to fit. Each
  line of speech is capped, each section has a share, and the transcript takes what is left.
  Anything cut is listed in a notice that names the journal and the head transcript, where
  the full text stays.
- **Fence.** Speech is data, never structure. Every piece of it becomes one line with
  whitespace and control characters flattened and the header, delimiter, `key=` and
  `</channel>` patterns defused. For `room` and `guest` conversations the summary, asks,
  commitments and transcript all sit between two `SPEECH` lines with a `| ` in front of every
  line, under a trusted header the speaker cannot reach. For `personal` conversations the
  transcript is fenced the same way.
- **Refusals.** A transient failure (a 5xx, no connection, 401, 403, 408, 429) is retried until
  it lands. Any other 4xx means the hub read the message and said no. The head then sends a
  short notice that names the archive, and if that is refused too it marks the conversation
  `undeliverable`, logs it, and stops. `/end` answers `{"merged": false, "delivery": ...}`.
  A soft merge refused for good is not retried; the hard merge then carries its ask as new.

## Limits

- The bearer token and every spoken word cross the LAN in cleartext. Anyone who can sniff the
  desk PC's traffic can open a `personal` fork of main with the token. The LAN already carries
  Home Assistant over plain http. The cheap options do not close it: a source-address
  allowlist leaves the token sniffable, and TLS needs a certificate the desk client trusts.
  Put the head behind a TLS-terminating route before it faces anything less than the home LAN.
- A fork runs in `<state_dir>/fork`, not in main's directory, and resumes main through a
  symlink to main's transcript there. Its own transcript therefore lands in a separate
  project directory, so anything that picks main's newest session by directory listing never
  picks a fork.

## Configuration

Every host-specific value comes from a TOML file outside the repository:

```toml
listen = ["127.0.0.1:8791"]
token_file = "/path/to/voice-head-token" # created with mode 600 when absent
state_dir = "/path/to/state"
main_cwd = "/path/main/runs/in"
# The command that starts Claude Code. Put a memory cap in front of it.
claude = ["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=2G", "claude"]
model = "opus" # personal tier; a fork answers fastest on the parent's model
cold_model = "haiku" # room and guest tiers
effort = "low"
soft_merge = "asks" # or "every": relay every exchange, at one turn of main each
idle_timeout_s = 120
max_open = 2
tts_unload_command = [
	"ssh",
	"-oBatchMode=yes",
	"-oConnectTimeout=2",
	"gpu-host.local",
	"curl --fail --silent --max-time 2 -X POST http://127.0.0.1:8735/unload",
]
unmerged_channels = ["desk-test"] # test channels: answered and journaled, never delivered

[hub]
url = "http://127.0.0.1:8980"
token_file = "/path/to/cc-link-token"
state_file = "/path/to/cc-link/state.json"
```

The head reads main's current session id from the hub's state file each time a
conversation opens, so a fork follows main into a fresh session.

Run it:

```sh
python -m janet_voice_head.server --config /path/to/head.toml
```

## Tests

Verified personal calls with lab access also receive `mcp__janet_lab__matrix_recent`.
It reads both sides of `janet-dm` through the configured Hermes hub's read-only
`history` tool. `limit` defaults to 10 and accepts 1 to 50. Results are oldest first,
with sender IDs and UTC Matrix timestamps, from the latest 50 events. Non-message
events are skipped. Each message is capped at 1600 characters, and the complete
result fits 12000 UTF-8 bytes. Truncation is explicit; the newest messages survive
when the result is too large. The upstream response is capped at 256 KiB and the
whole lookup shares the lab tools' three-second deadline. Guest, room, and
unverified personal calls never load this MCP server. No Matrix send tool is exposed.

Personal prompts distinguish inherited Matrix context at the call's snapshot from
newer messages read with this tool. Test conversations on `desk-test` never merge
into main.

The tests start the real server as a subprocess, with a fake `claude` binary and a fake
hub, and drive it over HTTP. They need no model and no network. The crash tests kill the
server between the hub's accept and the journal write. Run them from this directory:

```sh
python -m unittest discover -s tests -t .
```

## Read-only lab access on Parker's phone

Set `lab_token_file` to a local private credential file. The head creates it mode 600 if absent.
The ordinary bearer still authenticates the voice transport. A personal fork additionally requires
`X-Janet-Lab-Token` to match this separate credential; without it, a personal request becomes a
fresh guest session. An incorrect supplied credential returns 403. The credential is required on
turn, interrupt and end requests for that conversation, and client references cannot cross tiers.
With `lab_token_file` unset, existing tier behavior is retained and no lab tools are enabled.

The phone bridge holds a copy of this credential and sends it only for a device enrolled through
Parker's direct SSO sign-in (`identity_verified` and `paired_by == lab_owner`), on a personal line.
Shared pairing links and older enrollments do not establish the recipient's identity. Re-sign in
from the app after upgrading. A guest line stays guest even for Parker. Phones cannot forward an
identity header of their own. Desk headphone selection is not speaker verification, so desk/Mac
clients without this credential remain guests when the lab gate is enabled.

The MCP allowlist is `builders`, `objectives`, `health`, and `pull_requests`, under `janet_lab`.
Every tool takes an empty object; commands, paths, repository names and shell text are not inputs.
Builders return only unit names and states, never descriptions, logs or task prompts. Objectives
use the existing `~/.local/state/objectives-index-pkg/bin/sessionstart-objectives` command
and return only its bounded index entries, with no hook instructions or background-output paths.
The ledger is opened without following symlinks and passed as stdin, so pathname replacement cannot change the approved source. Health uses `uptime`, `free -m`,
and `df -h /`; it does not invoke the health watcher, which writes state and can send alerts.
PRs use fixed `gh pr list --repo` commands for `PetalNet/monorepo` and `PetalNet/janet-nix`; the
host needs existing GitHub CLI authentication, otherwise this lookup reports unavailable.
Messages, recall, calendar, arbitrary files, secret tools and write commands are not exposed.

Each lookup has a three-second total command deadline and a 12 KB per-source output limit.
The lean fork loads only this stdio MCP server and its configured public web tools, with no shell,
file editing tools, inherited MCP configuration or main plugins. Lab access refuses main-like
fork mode. Tool startup is checked against the same allowlist before any answer is spoken.
The head flushes the short spoken filler when the model starts a tool call. Writes continue
through the existing relay to main Janet.

Python extends the existing voice runtime without a new service framework or dependency.
Run the suites with the phone's existing websockets, numpy and qrcode dependencies available.
The opt-in `tests/prove_lab_call.py --output <directory> --tts <host:port>` runs real Claude,
the live systemctl tool, HTTP gateway, device admission, phone reply and Wyoming synthesis.
It scripts the STT text and uses an isolated parent session, registry and hub; it does not inject
into main or send notifications. It writes Parker/guest WAVs and a JSON proof transcript.
