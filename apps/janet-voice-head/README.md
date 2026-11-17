# Janet voice head

The voice head answers spoken turns for a voice client and keeps a long-running Claude
Code session ("main") informed of what was said. A client (the desk client, later a
phone line) sends text it transcribed and speaks the sentences it gets back. The design
is in [docs/janet-voice/SPEC.md](../../docs/janet-voice/SPEC.md), §9 and §10.

One conversation is one talk-only Claude Code process:

- **Fork at wake.** `POST /v1/conversations` starts `claude --resume <main> --fork-session`
  the moment the wake word fires. The process loads main's transcript and calls no model,
  so the head knows everything main knew at that second and is ready when the first
  transcribed turn arrives. Nothing calls a model while nobody speaks.
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
python -m unittest tests.test_head
```
