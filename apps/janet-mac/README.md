# Janet for macOS

One key on a Mac does two things:

- **Hold it** to dictate. [Hex](https://github.com/anomalyco/hex) records, transcribes on the Mac
  with Parakeet, and types the text into the focused app.
- **Double tap** to talk to Janet. Tap twice and talk: she listens until you stop. Or keep the
  second press held and let go when you are done. The reply shows as a notification and is spoken
  in Janet's voice.

Nothing of ours stays running. Hex is the only resident process. `janet-talk` is a shell
script that Karabiner-Elements starts on the key events, and it exits when the reply has played. While a recording is open a small loop tells Hex
every three seconds that it is still wanted; it ends with the recording, and after two minutes at
the latest.

```text
key ── Karabiner ──┬─ first press ──> F18 ──> Hex dictation (types into the focused app)
                   └─ second press within 300 ms
                        key down ──> janet-talk start ──> Hex starts recording
                        key up   ──> janet-talk stop  ──> transcript ──> voice gateway ──> voice head
                                                          sentences  <── notification + speech
```

The first press always goes to Hex at once, so dictation never waits to see whether a second tap
is coming. A double tap leaves Hex a recording a fraction of a second long with no speech in it,
which it drops.

A second press shorter than 0.4 s is a tap. Janet then listens for as long as you talk and stops
when your turn has ended. There is no limit on how long you may talk; a five-minute backstop
exists only so a stuck listen cannot run for ever. She gives up after 6 s if nothing is said at
all. Another double tap ends the listening within a fraction of a second. A held press ends on
release, with no wait for quiet.

Two models decide when the turn has ended, from the microphone audio Hex streams
([`turn_end.py`](turn_end.py)). Both run on the Mac, and no audio leaves it for this.
[Silero VAD](https://github.com/snakers4/silero-vad) says whether the latest audio is speech.
[Smart Turn](https://github.com/pipecat-ai/smart-turn) listens to the turn so far and says whether
it sounds finished. Silence alone cannot tell a finished thought from a pause to think, so the
longer the silence, the less sure Smart Turn has to be:

| Silence       | The turn ends if Smart Turn is |
| ------------- | ------------------------------ |
| 1 s and 1.5 s | over 98% sure it is finished   |
| 2 s and 2.5 s | over 90% sure                  |
| 3 s           | over 50% sure                  |
| 4 s           | whatever it says               |

Speech starts the count again; a click does not. Each listen logs why it ended and what Smart Turn said, in
`~/Library/Caches/janet-talk/talk.log`.

When the models give no verdict (they are not installed, they failed to run, or this Hex has no
audio stream), "quiet" and "speech" are judged against the room instead, and the listen ends after
1.3 s of quiet. They are judged from the microphone level Hex reports, so a loud
room or a different microphone needs no setting. The room level is the lowest "quietest tenth" heard
so far, and talking cannot raise it. If nothing comes near it for eight seconds, the room itself
got louder (a fan started), and the level is taken again from those eight seconds. A sample is loud
when it stands 10 dB above the room; a real room wanders by several dB, so quiet means "nothing
loud", not "everything low". Speech is eight loud samples within a second, which a click is not and
a cough can be. The first half second is ignored while the microphone opens.

One case it gets wrong: if a noise that was there from the start stops before you speak, that
noise is taken for speech and the listen ends 1.3 s later.

## What `janet-talk` does

- `start` (key down): stops a reply that is still playing and tells the head which sentences were
  heard, starts a recording through Hex's local API (which never pastes), opens the head conversation, and asks the voice for a throwaway
  word so a sleeping voice host starts waking before the question is finished.
- `stop` (key up): after a tap, waits for the speaker to stop; then takes the transcript from Hex, sends it as a turn, and for each sentence of the
  reply fetches the audio and plays it in order. Sentences are synthesized one at a time, in order, while the one before plays, so the first is always ready first. The whole reply is shown as one notification as
  soon as the text is complete, which is before the audio finishes.
- When the voice host is asleep the gateway answers 503 and sends it a wake packet. The text is
  shown at once, a second notification says the voice is waking, and the audio plays when the
  voice answers (it keeps trying for four minutes).
- Whatever the Mac is playing (a show in a browser, Spotify, anything that shows in Now Playing) is
  paused when Janet starts speaking and resumed when the reply ends or a new press cuts it off.
  It is paused only if it was playing, and resumed only if nothing else has started since. This
  goes through [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter), which
  `install.sh` builds (needs git and cmake); macOS 15.4 and later block MediaRemote for ordinary
  programs, and the adapter borrows `/usr/bin/perl`'s entitlement. Checked on macOS 27.0.1.
- A follow-up within 90 seconds continues the same conversation. An end phrase ("that's all")
  ends it.

It needs only what macOS ships: `bash`, `curl`, `jq`, `afplay`, `osascript`, `security`, `perl`.
Timings for every press are in `~/Library/Caches/janet-talk/talk.log`.

## Install

1. Install Hex from its site, grant it Microphone and Accessibility, pick Parakeet Unified English,
   and set its shortcut to F18:

   ```sh
   hex=/Applications/Hex.app/Contents/MacOS/hex
   $hex model install parakeet_unified_en
   $hex settings set dictation_hotkey f18
   $hex settings set shortcut_mode hold
   $hex settings set double_tap_lock false
   $hex launch-at-login on
   ```

2. Install Karabiner-Elements and open it once.
3. Run the installer with the gateway's URL. It reads three lines on standard input: the Cloudflare
   Access client id, the client secret, and the voice head's token.

   ```sh
   ./install.sh https://voice.example.com < secrets
   ```

   The secrets go to the login Keychain (service `janet-voice`). The URL goes to
   `~/.config/janet-talk/config`. `turn_end.py`, its two models (11 MB, checked against their
   checksums) and a Python environment with `numpy` and `onnxruntime` go to
   `~/.local/share/janet-talk`. The rule in [`karabiner/janet-talk.json`](karabiner/janet-talk.json)
   is merged into the selected Karabiner profile. It matches the microphone key of a MacBook in
   both forms a keyboard can report it (`key_code: f5` and `consumer_key_code: dictation`); change
   `from` for another key. Turn off the system's own use of that key (Dictation, and Siri's
   "hold microphone key") so only Karabiner answers it.

## Network

`janet-talk` speaks only to the [voice gateway](../janet-voice-gateway) over HTTPS. Every request
carries a Cloudflare Access service token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`) and
the voice head's bearer token. The gateway checks the bearer token and the head checks it again.
No VPN is involved.

## Tests

```sh
python3 -m unittest discover -s tests
```

The tests run the real script against the real gateway, with stand-ins for the head, the voice
server, and the Mac programs (`hex`, `afplay`, `osascript`, `security`).
