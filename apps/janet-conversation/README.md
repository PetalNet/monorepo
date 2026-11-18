# Janet conversation agent for Home Assistant

Janet as a Home Assistant Assist conversation agent. It is a thin client of the voice head's
(`apps/janet-voice-head`) `/v1/conversations` API, so a spoken turn from a phone, a watch or any Assist
surface is answered by the same fork of main Janet, with the same history, and is folded back into main
by the head's merge. This app holds no history and no fork logic of its own.

- **Streaming.** Each `sentence` event from the head becomes one chat-log delta, so the Assist pipeline
  starts text to speech at the first sentence. The head reports `latency_ms` on its `done` event.
- **Tier.** The configured owner's Home Assistant user gets the head's `personal` tier (the fork of main).
  Every other user, and any turn without a user, gets `guest`, a session with no memory of main whose
  speech reaches main only as fenced, untrusted text. An empty owner setting grants nobody `personal`.
- **Surface.** Each conversation opens with channel `ha:<device name>` (`ha:assist` when the turn has no
  device), which the head files into the shared history.
- **Lifecycle.** One Home Assistant conversation is one head conversation. An end phrase ends it. A head
  conversation that timed out is replaced once, before any speech; a second failure is said aloud as
  "I can't reach Janet right now."
- **Network.** Home Assistant talks to the head over the LAN. Phones reach Home Assistant through its
  normal external URL; nothing here uses Tailscale.

## Install

Copy `custom_components/janet_conversation` to `<config>/custom_components/` and restart Home Assistant.
Then add the config entry (the head's URL and bearer token, and the owner's Home Assistant user id), a
Wyoming entry for the Chatterbox voice, and an Assist pipeline (Wyoming faster-whisper, Janet, Chatterbox).
The lab's script for this lives with its other Home Assistant setup in PetalNet/petalnet-infra.

## Tests

The tests replay a stream recorded from the real head against a fake head. They need `aiohttp` and no
Home Assistant:

```sh
python -m unittest discover -s tests -t .
```

`conversation.py` and `config_flow.py` import Home Assistant and are exercised only in a running instance.
