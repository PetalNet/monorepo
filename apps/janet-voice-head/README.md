# Janet voice head

The voice head answers spoken turns for a voice client and keeps a long-running Claude
Code session ("main") informed of what was said. A client (the desk client, later a
phone line) sends text it transcribed and speaks the sentences it gets back. The design
is in [docs/janet-voice/SPEC.md](../../docs/janet-voice/SPEC.md), §9 and §10.

One conversation is one talk-only Claude Code process:

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
- **Talk only.** The process runs with no tools, no MCP servers, no settings, and an
  allowlisted environment. The head reads the session's own report of its tools and never
  uses a session that reports any.
- **Soft merge.** The model ends a reply with a `<relay>` block when the speaker asked for
  something to be done. The head strips the block from speech and injects the ask into
  main at once, so main acts during the call.
- **Hard merge, once.** When the conversation ends, the head injects one message into
  main: the transcript, a summary, and every ask marked as already relayed or new.
- **Tiers.** `personal` is the fork. `room` and `guest` are a fresh session in an empty
  directory with no memory of main. Their conversations reach main labelled as untrusted
  speech, and their asks are never relayed for action.

## API

Bearer token on every `POST`. Bodies and replies are JSON.

| Call                                    | Body                                  | Reply                              |
| :-------------------------------------- | :------------------------------------ | :--------------------------------- |
| `GET /health`                           |                                       | `{"ok": true, "version": "0.1.0"}` |
| `POST /v1/conversations`                | `{"channel", "tier"?, "client_ref"?}` | `{"id"}`                           |
| `POST /v1/conversations/{id}/turns`     | `{"text"}`                            | `text/event-stream`                |
| `POST /v1/conversations/{id}/interrupt` | `{"heard_text"}`                      | `{"ok": true}`                     |
| `POST /v1/conversations/{id}/end`       | `{"reason"}`                          | `{"merged": true, "delivery"}`     |

- `tier` is `personal`, `room` or `guest`. A request without one gets `guest`.
- The same `client_ref` returns the same conversation, so a client can retry the call.
- A turn streams one `sentence` event (`{"text"}`) per speakable sentence, then one
  `done` event: `{"end_conversation": bool, "latency_ms": {"first_token", "first_sentence",
"total", "spawn_wait"}}`. A turn that arrives before the session is ready waits for it.
- An end phrase ("that's all", "goodbye", "never mind") gets a sign-off sentence without a
  model call and `end_conversation: true`. The client then calls `end`.
- `interrupt` stops a reply that is still being generated. `heard_text` is what the speaker
  heard before cutting in; the head tells the model so on the next turn and in the merge.
- `end` is idempotent. A conversation with no turn for `idle_timeout_s` ends itself, so a
  crashed client still gets its conversation merged.

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
token_file = "/path/to/voice-head-token"   # created with mode 600 when absent
state_dir = "/path/to/state"
main_cwd = "/path/main/runs/in"
# The command that starts Claude Code. Put a memory cap in front of it.
claude = ["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=2G", "claude"]
model = "opus"            # personal tier; a fork answers fastest on the parent's model
cold_model = "haiku"      # room and guest tiers
effort = "low"
soft_merge = "asks"       # or "every": relay every exchange, at one turn of main each
idle_timeout_s = 120
max_open = 2
unmerged_channels = ["desk-test"]   # test channels: answered and journaled, never delivered

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

The tests start the real server as a subprocess, with a fake `claude` binary and a fake
hub, and drive it over HTTP. They need no model and no network. The crash tests kill the
server between the hub's accept and the journal write. Run them from this directory:

```sh
python -m unittest discover -s tests -t .
```
