# Janet desk

The desk end of the [Janet voice system](../../docs/janet-voice/DESK.md). It listens on a microphone,
uses a Home Assistant Assist pipeline for the wake word and speech to text, sends each utterance to
the voice head, speaks the head's reply through a
[Wyoming](https://github.com/OHF-Voice/wyoming) text-to-speech server such as
[chatterbox-wyoming](../chatterbox-wyoming), and plays it on the output device.

A conversation is one state machine (`janet_desk/client.py`):

```text
idle ── wake word ──> waking ──> listening ── transcript ──> thinking ── first audio ──> speaking
  ^                                  │ nothing said                                         │
  │                                  v                                                      │
  └── silence, or the head ends it ── follow-up <────────── reply finished, or interrupted ─┘
                                        │ transcript
                                        └──> thinking
```

- **Conversation mode.** After a reply the microphone stays open with no wake word. The
  conversation ends when nobody speaks for `follow_up_seconds`, or when the head marks its reply
  `end_conversation`.
- **Interrupting.** On a headphone output, `barge_in_seconds` of speech stops playback at once, tells
  the head which words were heard, and becomes the next turn, including the audio from before the
  cut. On any other output the microphone hears the reply itself, so only the wake word interrupts.
- **Privacy tier.** The client reports `personal` when the output device is one of the configured
  `headphones`, and `room` otherwise.
- **Speed.** When the wake word fires, before speech to text finishes, the client opens the head
  conversation and asks the voice server for a throwaway word, so a voice model that unloaded while
  idle starts loading at once. It synthesizes each sentence while the one before it plays.

`janet_desk/head.py` (the head's HTTP client), `janet_desk/audio.py` and the state machine have no
desk dependency. `janet_desk/ha.py` and `janet_desk/devices.py` are the desk's: another front end,
such as a phone line, replaces those two.

## Install

Windows with Python 3.12. The device code uses WASAPI.

```sh
uv pip install "janet-desk @ git+https://github.com/PetalNet/monorepo#subdirectory=apps/janet-desk"
```

Home Assistant needs an Assist pipeline with a wake word and a speech-to-text engine, and a
long-lived access token for the client.

## Configuration

```toml
[home_assistant]
url = "http://homeassistant.local:8123"
token_file = "/path/to/ha-token"
pipeline = "Janet"                       # the Assist pipeline's name

[head]
url = "http://voice-head.local:8791"
token_file = "/path/to/head-token"
channel = "desk"                         # optional

[voice]
wyoming = "tcp://127.0.0.1:10230"
name = "janet"

[audio]
microphone = ""                          # a name from --list-devices; empty is the system default
output = ""                              # same; the default is read once, at start
headphones = ["Headphones (My Headset)"] # outputs that count as private
volume = 1.0                             # optional

[conversation]                           # optional
follow_up_seconds = 6.0
barge_in_seconds = 0.3
stall_seconds = 30.0                     # give up on a transcript after this long
```

```sh
janet-desk --list-devices
janet-desk --config desk.toml
```

## Replaying a conversation

`--mic-script` replaces the microphone with recorded audio played in real time, and
`--record-output` writes what would have been played to a WAV instead of playing it. Together they
run the whole path, Home Assistant, head and voice included, with no audio hardware. `--trace`
writes each event with its time, which gives the latency of every stage.

```sh
janet-desk --config desk.toml --record-output reply.wav --trace trace.jsonl \
  --mic-script "silence:1 wav:hey-janet.wav wav:question.wav wait:playback_start silence:2 wav:interruption.wav wait:idle"
```

Script steps: `wav:<16 kHz mono 16-bit file>`, `silence:<seconds>`, and `wait:<event>`, which stays
silent until that trace event happens after the latest `wav` began. Events: the state names (`idle`,
`waking`, `listening`, `thinking`, `speaking`, `follow_up`), `wake_detected`, `stt_final`,
`head_first_sentence`, `tts_first_audio`, `playback_start`, `playback_stop`, `barge_in`,
`conversation_end`, `head_ended`, `error`. The client exits when the script ends and the conversation is over.

## Tests

The tests drive the state machine with a scripted microphone and fakes for Home Assistant, the
head, the voice and the output device. They need `aiohttp` and no audio hardware.

```sh
python -m unittest discover tests
```
