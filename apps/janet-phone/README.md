# Janet phone

A phone call to Janet. A caller's device opens one WebSocket and streams microphone audio. The
bridge turns that into a conversation with the voice head (`apps/janet-voice-head`) and streams
Janet's voice back. The design is in [docs/janet-voice/SPEC.md](../../docs/janet-voice/SPEC.md), §14.

```text
caller ── WebSocket ──► janet-phone ──► Wyoming speech-to-text
                             │
                             └──► janet-voice-gateway ──► voice head (one conversation per call)
                                                     └──► Wyoming text-to-speech
```

One call is one head conversation at the tier the bridge is configured with, never one the caller
names. The head session has no tools, and the caller's words reach it as speech to answer, not as
instructions.

- **Disclosure first.** The first thing a caller hears is the configured `disclosure` sentence. It is
  fixed text, not model output, and the caller cannot cut it off.
- **No secrets.** The bridge forwards the caller's `Authorization` and `Cf-Access-Jwt-Assertion`
  headers to the gateway, which checks both. A caller the gateway refuses gets HTTP 403 and no socket.
- **Cut-off.** When the caller speaks over a reply, the bridge stops sending it, tells the device to
  drop what it has queued, and tells the head how much was heard.
- **Call record.** When the call ends, the bridge ends the conversation and pipes a plain-text record
  (time, length, caller class, transcript) to the `notify` command. `matrix_notice.py` is one such
  command: it posts standard input to a Matrix room as a notice.

## Protocol

`GET /v1/call` upgraded to a WebSocket, with the gateway's bearer token.

| Direction        | Message                         | Meaning                                              |
| :--------------- | :------------------------------ | :--------------------------------------------------- |
| device to bridge | binary                          | microphone audio, mono PCM16LE at 16 kHz, continuous |
| bridge to device | `{"type": "audio", "rate": n}`  | sample rate of the binary audio that follows         |
| bridge to device | binary                          | Janet's voice, mono PCM16LE, paced near real time    |
| bridge to device | `{"type": "clear"}`             | the caller cut in: drop queued audio                 |
| bridge to device | `{"type": "bye"}`, then a close | Janet ended the call                                 |

Closing the socket hangs up.

## Configuration

```toml
listen = "127.0.0.1:8793"
gateway = "http://127.0.0.1:8792"   # janet-voice-gateway
stt = "stt-host.local:10300"        # Wyoming speech-to-text
tier = "guest"                      # the head tier every call on this bridge gets
channel = "phone"
disclosure = "Hi, this is Janet, an automated assistant for Parker. This call is being transcribed."
notify = ["python3", "/app/matrix_notice.py", "--homeserver", "https://matrix.example", "--creds", "/secrets/creds.json", "--store", "/state/store", "--room", "!room:example"]
record_dir = ""                     # set to keep both sides of every call as WAV files

[endpoint]                          # loudness end-of-speech detector
threshold = 500
silence_ms = 700
```

Run it with `python janet_phone.py --config /path/to/phone.toml`, or build the `Dockerfile`.

## Limits

- End of speech is a loudness threshold and a fixed silence. `Endpointer` is the one place a better
  detector plugs in.
- A reply is synthesized one whole sentence at a time, so the first audio of a reply waits for the
  first sentence.
- Cut-off relies on the calling device cancelling its own echo. A device that plays Janet through a
  loudspeaker without echo cancellation will cut her off with her own voice.
- The call record carries the caller's words. Post it where a person reads it, not where an agent
  with tools takes messages as instructions.

## Tests

The tests run the real bridge against a fake gateway and a fake speech-to-text server:

```sh
python -m unittest discover -s tests -t .
```
