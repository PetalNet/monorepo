# Chatterbox Wyoming

A [Wyoming](https://github.com/OHF-Voice/wyoming) text-to-speech server for a
Chatterbox Turbo voice runtime with the Resemble Enhance post-filter. One process
serves:

- Wyoming `describe` and `synthesize` on each configured `wyoming` URI. Text is split
  into sentence groups. The server sends `audio-start`, one `audio-chunk` per group as
  soon as that group is ready, then `audio-stop`. Audio is PCM16 mono at 24 kHz,
  resampled from the model's 44.1 kHz with a polyphase low-pass filter.
- HTTP on each configured `http` bind: `POST /tts` (text body, returns a 44.1 kHz WAV)
  and `GET /status` (read-only JSON for a load balancer: `name`, `loaded`, `busy`,
  `queue_depth`, `last_synth_rtf`, `gpu_name`, `free_vram_gb`, `total_vram_gb`).

The model loads on the first request and unloads after `idle_unload_seconds` without
requests, so other GPU applications get the memory back. After each synthesis it also
releases PyTorch's cached GPU blocks, because a long sentence group can briefly need
much more memory than the loaded model. One worker thread runs every synthesis, so
requests are serialized. Empty text returns `audio-start` and
`audio-stop` with no audio. A model or CUDA error sends a Wyoming `error` event, closes
that connection, and drops the model so the next request reloads it.

Wyoming has no authentication. Bind it to loopback, or restrict a LAN bind with a
host firewall rule that allows only the clients you trust.

## Runtime environment

The voice runtime is not part of this repository. It needs Python 3.12, CUDA, and the
runtime's tested dependencies (torch 2.8.0+cu128 and numpy 1.26.4). Install this
package's dependencies into that same environment:

```sh
uv pip install --python <runtime-venv>/python numpy scipy soundfile "wyoming>=1.8,<2"
```

## Configuration

Every host-specific value comes from a TOML file outside the repository, so the same
code runs unchanged on another GPU host:

```toml
name = "gpu-host-1"                    # instance name, reported by describe and /status
runtime = "/path/to/voice-runtime/outputs/runtime"
gpu_index = 0                          # nvidia-smi index; the server pins CUDA to it
wyoming = ["tcp://127.0.0.1:10230"]
http = ["127.0.0.1:8735"]
idle_unload_seconds = 600
voice_name = "default"
log = "/path/to/chatterbox-wyoming.log" # used when there is no console (pythonw)
```

Run it:

```sh
python chatterbox_wyoming.py --config /path/to/config.toml
```

The log records each cold load, every synthesis with its real-time factor, and free
VRAM.
