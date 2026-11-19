# Janet voice note

A recorded voice note in, a voice note out, through the same two
[Wyoming](https://github.com/OHF-Voice/wyoming) servers the live voice surfaces use: the
speech-to-text server that [janet-phone](../janet-phone) and the desk call, and the voice that
[chatterbox-wyoming](../chatterbox-wyoming) serves. A note is heard by the same model as a call and
answered in the same voice.

```text
note.ogg ── ffmpeg ──► mono PCM16, 16 kHz ──► Wyoming speech-to-text ──► transcript
text ──► Wyoming text-to-speech ──► PCM ── ffmpeg, loudness, Opus ──► reply.ogg
```

## Use

```sh
python janet_voice_note.py hear --stt stt-host.local:10300 note.ogg
python janet_voice_note.py say --tts gpu-host.local:10230 --voice default --out reply.ogg "The words to speak."
```

- `hear` prints the transcript and nothing else on standard output. It reads any file ffmpeg reads
  and sends the whole recording as one utterance, however long.
- `say` prints the path of the finished file and nothing else on standard output. The text is one
  request; the voice server splits it into sentences itself. `-` as the text reads standard input.
  The file is Opus in Ogg at 48 kbit/s, brought to -14 LUFS so it plays as loud as other media, and
  it appears only when it is whole.
- Both report on standard error which program and model answered, where, and how long it took. The
  model behind a port can change (a server may swap to a smaller one while its GPU is busy), so the
  line names what `describe` said at that moment.

`--ffmpeg PATH`, before the command, names the ffmpeg program when it is not on `PATH`.

## When the voice host is off

| Exit status | Meaning                                                   |
| :---------- | :-------------------------------------------------------- |
| 0           | done                                                      |
| 1           | the server answered and then failed, or ffmpeg failed     |
| 3           | nothing answers on the server's port                      |

Status 3 is the one a caller can act on, by waiting or by using another path. `say` can wake the
host first:

```sh
python janet_voice_note.py say --tts gpu-host.local:10230 --out reply.ogg \
  --wake-mac aa:bb:cc:dd:ee:ff --wake-broadcast 192.0.2.255:9 --wake-wait 90 "The words to speak."
```

With `--wake-mac`, a voice host that does not answer is sent a Wake-on-LAN packet and tried again
every 2 s for `--wake-wait` seconds before the command gives up with status 3. The packet is a
broadcast, so the command must run on the same layer-2 network as the voice host.

Wyoming has no authentication. Run this where the servers' own firewall rules already allow.

## Tests

The tests use a stand-in Wyoming server and a stand-in ffmpeg, so they need neither.

```sh
python -m unittest discover -s . -t .
```
