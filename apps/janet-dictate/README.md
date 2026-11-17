# janet-dictate

A small native macOS dictation agent. Hold a key, speak, release: the text is pasted into the focused app.

It uses Apple's on-device SpeechAnalyzer. The speech model is a system asset, so the agent itself holds almost nothing while idle. There are no polling timers, no open microphone, and no loaded model between recordings.

## Build

Needs macOS 26 or newer and Xcode.

```sh
./bundle.sh              # builds ~/Applications/janet-dictate.app (ad-hoc signed)
./bundle.sh /some/dir    # or build somewhere else
swift test               # unit tests for the pure logic
```

Ad-hoc signing gives the app a new identity on every build. After a rebuild, allow Accessibility for it again.

The app bundle has id `dev.petalnet.janet-dictate` and `LSUIElement` set, so it has no Dock icon. macOS attributes its permission prompts to this bundle.

## Run

```sh
open ~/Applications/janet-dictate.app
```

The agent does not start at login. Add a login item or a launchd agent yourself if you want one.

Hold F19 to talk. Release to paste.

F19 is not on a MacBook keyboard. The key is meant to be produced by a remapper, for example Karabiner mapping the microphone key to F19. To use a key you do have, pass `--key`, for example `--key f13` or `--key ctrl+opt+space`.

## Change the key

Pass `--key` or set a defaults value. The argument wins. Other options work the same way: `--max-seconds` (defaults key `maxSeconds`), `--retention` (defaults key `retention`), and `--control-socket` (defaults key `controlSocket`).

```sh
open ~/Applications/janet-dictate.app --args --key f18
defaults write dev.petalnet.janet-dictate key -string "ctrl+opt+space"
```

Environment variables do not reach an app started with `open` unless you pass `--env`, so the options above are the way to configure it.

Keys are `f1` to `f20`, `space`, `return`, `tab`, `escape`, `grave`, letters, or `keycode:N`. Modifiers are `cmd`, `shift`, `opt`, `ctrl`, joined with `+`.

## Permissions

- Microphone: asked on the first recording. Click Allow.
- Accessibility: needed to post Cmd+V. Without it the text is left on the clipboard and one notification says so. Add the app under System Settings, Privacy & Security, Accessibility.
- Notifications: used for the Accessibility message, for "copied, not pasted" notices, and for errors.

The global hotkey itself needs no permission.

## Control from a script

This is off by default. Any process of your user that can reach the socket can start the microphone and read the transcript with the agent's permissions, so only turn it on if you need it. Enable it with `--control-socket` or `defaults write dev.petalnet.janet-dictate controlSocket -bool true`. The agent also refuses connections from any other user id.

With it on, the same binary talks to the running agent over a Unix socket in `~/Library/Caches/janet-dictate/` (directory mode 700, socket mode 600). With it off there is no socket, and these commands exit 3 and name the switch.

```sh
BIN=~/Applications/janet-dictate.app/Contents/MacOS/janet-dictate
$BIN start                 # begin recording
$BIN stop --print          # end it, print the text, paste nothing
$BIN stop                  # end it and paste
$BIN cancel                # discard
$BIN status                # idle, recording or finishing
```

Exit codes: 0 ok, 1 error, 2 usage, 3 agent not running or control socket off, 4 no speech heard (nothing printed).

A recording that is not stopped within 120 seconds (`--max-seconds`) ends by itself. A hotkey recording pastes what was heard. A socket recording keeps its transcript for 30 more seconds for a later `stop --print`, then drops it. If the input device changes mid-recording, the recording ends the same way.

## Transcribe a file

```sh
$BIN transcribe file.wav                  # {"text": ..., "ms": ...}
./bench.sh $BIN                           # 20 TTS utterances, WER and latency
./bench.sh $BIN --realtime              # audio paced like a microphone; times release-to-text
```

The file path and the microphone path share one code path: audio buffers go into a `Transcription`, which converts them and feeds SpeechAnalyzer.

Pass `--retention lingering` to the agent or to `--bench` to keep the system model loaded a little after each use. The default, `whileInUse`, lets it go at once.

## How the clipboard is handled

The text is written to the general pasteboard marked as transient and concealed (`org.nspasteboard.TransientType` and `org.nspasteboard.ConcealedType`), so clipboard managers skip it. Cmd+V is posted, and 1 s later the previous contents are restored, marked transient so clipboard managers skip them. If something else wrote to the clipboard in the meantime, it is left alone. The paste is skipped, and the text stays on the clipboard, if the focused app changed since you released the key or a secure text field is active.

## Measured numbers

Measured on 2026-11-17 on a MacBook Air M4, 24 GB, macOS 27.0.1, on battery in Low Power Mode. The audio is TTS (`say -v Samantha`, 16 kHz), not a human voice, so treat the accuracy as a rough guide.

| Measure                                  | janet-dictate | Hex (Parakeet) |
| ---------------------------------------- | ------------- | -------------- |
| Idle CPU, 60 s after start               | 0.0 %         | 3.5 to 4 %     |
| Idle memory (phys_footprint)             | 7.4 MB        | 230 to 240 MB  |
| WER, 20 utterances                       | 1.55 %        | 1.04 %         |
| Whole file in, text out: median          | 146 ms        | 204 ms         |
| Whole file in, text out: p90 / max       | 273 / 505 ms  | 324 ms / n/a   |
| Release to text (paced audio): median    | 107 ms        | n/a            |
| Release to text (paced audio): p90 / max | 138 / 146 ms  | n/a            |

The first utterance is run once and not counted. Each counted run builds a fresh analyzer, as a real key press does. With `lingering` retention the whole-file median was 126 ms.

The three misses were "career affair", "pool request" and "flag ... 645" for "flight ... six forty five".

## What is not proven

- Speech into the microphone: a 2 s recording of room quiet ended with exit 4 (no speech) and 73 ms from stop to result. It was not tested with a human voice.
- The hotkey press and release path, and the paste with Cmd+V, were not exercised. The hotkey registers; nobody pressed it.
- The Accessibility-denied notice and the clipboard restore were not run either. Only their decision logic is unit tested.
- The length cap, the input-device-change path, and the focus-changed and secure-input paste guards were not exercised on the Mac. Only their decision logic is unit tested.
