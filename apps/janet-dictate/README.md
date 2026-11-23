# Streaming dictation

Keep FUTO as the keyboard. Its microphone can switch to the Kõnele voice keyboard, which writes
partial words into the focused text field using this lab Parakeet endpoint. For offline recognition,
FUTO can switch directly to Sayboard's voice keyboard and local Vosk model. [Android setup](android.md)
records both configurations and their incomplete device acceptance checks.

This Python service reuses `packages/janet-turn`'s ONNX decoder and model. Python keeps inference
in the same process as the WebSocket session, without a second model implementation or a bridge
between runtimes. It does not call Janet, a language model, or a batch transcription endpoint.

## Run

From the repository root:

```sh
docker build -f apps/janet-dictate/Dockerfile -t janet-dictate .
```

The image includes the same pinned, checksum-verified Parakeet INT8 model used by `janet-phone`.
Its weights use the [NVIDIA Open Model License](https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1).
The model supports English and emits words without punctuation. Kõnele handles display casing.

Create a private configuration directory and a dedicated token:

```sh
install -d -m 700 "$HOME/.config/janet-dictate"
python3 - <<'PY'
from pathlib import Path
import secrets
p = Path.home() / ".config/janet-dictate/token"
with p.open("x") as output:
    output.write(secrets.token_urlsafe(32))
p.chmod(0o600)
PY
```

Write `config.toml` in that directory:

```toml
models = "/models"
token_file = "/config/token"
host = "0.0.0.0"
port = 8795
max_sessions = 2
max_seconds = 120
idle_seconds = 10
```

Run the reviewed image built from merged main, with the directory readable by UID 1000:

```sh
docker run --rm --name janet-dictate \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8795:8795 \
  -v "$HOME/.config/janet-dictate:/config:ro" \
  janet-dictate --config /config/config.toml
```

Place it behind a TLS reverse proxy that supports WebSocket upgrades and does **not** log request
URLs or query strings on this route. The client URL is
`wss://<host>/client/ws/speech?key=<dedicated-token>`. Kõnele cannot send custom authentication
headers, so this credential must be in the URL. Do not reuse the voice head's token, publish the
backend port, or put the URL in screenshots, reports, shell arguments, or shared logs. Set proxy
idle timeouts above ten seconds and connection duration above two minutes.

Cloudflare Access service-token headers are incompatible with stock Kõnele. A deployment needs a
dedicated route that reaches this service's token check without an interactive Access login. Do
not remove Access from existing Janet routes. This PR does not configure or deploy that route.

For local development, run from the repository root:

```sh
uv run --locked --package janet-dictate janet-dictate --config /path/to/config.toml
```

Use a host model directory containing `parakeet_realtime_eou_120m.int8.onnx` and
`parakeet_vocab.txt`, and omit `host` to bind to loopback. The image recipe records the model
source and checksums.

## Wire behavior

The endpoint implements Kõnele's kaldi-gstreamer protocol:

- `GET /client/ws/speech?key=…`, followed by Kõnele's own query parameters. The exact raw content
  type is checked; FLAC and non-English requests are rejected before upgrade.
- Binary PCM16LE mono 16 kHz frames, normally about 200 ms each, or a single pre-buffered
  initial frame up to 35 seconds (1,120,000 bytes) from stock Kõnele. Frame boundaries may split a
  sample. Large frames are sliced into 160 ms chunks for decoding, with separate state per connection.
- Changed cumulative hypotheses are sent immediately with `status: 0` and `result.final: false`.
  Kõnele uses these to replace the current composing text.
- Text `EOS` pads the final chunk and feeds seven silent chunks, as required by the
  [model's streaming contract](https://huggingface.co/imbcmdth/parakeet-realtime-eou-120m-onnx/blob/974110555ac70906cbb1fe9f758cecde790d8645/STREAMING.md).
  The server then sends one final hypothesis and closes normally. Model end-of-utterance tokens
  do not end the dictation, so a pause does not commit or duplicate the words already displayed.
- Status `1` means no speech, `2` a time/audio limit, `5` invalid audio/control data, and `9` no
  decoder slot. An inference failure closes with code `1011`. Disconnect discards that session.

The default limits are two active decoders, two minutes of audio and elapsed time, ten seconds
without a message, 1,120,000 bytes per message, and four queued frames. Browser origins are rejected.
No audio or transcripts are persisted. The optional Kõnele server-status screen is not implemented;
its worker-count indicator is not a health check for this endpoint.

## Verify

```sh
pnpm --filter @petalnet-python/janet-dictate test:python
```

These tests use real WebSockets and a deterministic decoder to check the protocol, authentication,
format validation, finalization, silence, session isolation, limits, disconnects and model errors.
They do not prove recognition quality or Android behavior.

Replay a public PCM16 mono 16 kHz WAV at recording speed against a running real model:

```sh
uv run --locked --package janet-dictate python apps/janet-dictate/probe.py \
  --url ws://127.0.0.1:8795/client/ws/speech \
  --token-file "$HOME/.config/janet-dictate/token" /path/to/public-speech.wav
```

The probe sends Kõnele's upgrade headers and prints transcript events and elapsed times, never the token. It fails unless a partial
arrives before `EOS` and a nonempty final follows. Use public test speech because its transcript is
printed. Phone checks, including TLS and offline operation, are in [Android setup](android.md).
