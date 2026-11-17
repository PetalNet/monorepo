# The desk, as built

The first slice of the [voice system](SPEC.md): Parker at his desk says "hey Janet", and the reply
comes back in Janet's voice. Code: [`apps/janet-desk`](../../apps/janet-desk/README.md). This page
records how the desk works and where it departs from the spec.

## The path of a turn

```text
desk microphone
   │ 16 kHz audio over Home Assistant's WebSocket API
Home Assistant Assist pipeline "Janet"
   │ wake word: Wyoming openWakeWord on the desktop's CPU
   │ speech to text: Wyoming faster-whisper on the desktop's CPU
   │ text
desk client ── opens the conversation at the wake word, sends each transcript ──> voice head
   │ sentences, streamed
voice server on the desktop (Wyoming, loopback)
   │ audio
desk client plays it, and stops it when Parker talks over it
```

Home Assistant carries wake word and speech to text only. The pipeline ends at speech to text: the
client talks to the head and to the voice server itself, because a pipeline that hands out a
text-to-speech URL cannot stop the playback (§12).

## Departures from the spec

| Spec                                                                    | Built                                                                                     | Why                                                                                                                                                                                                                      |
| :---------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §11 Wake word on the device                                             | The model runs on the desk machine, served over Wyoming and called through Home Assistant | One wake word service for every later satellite. The client can move detection in-process without changing anything else.                                                                                                |
| §11 Speech to text central on the lab server                            | Speech to text runs on the desktop's CPU                                                  | The lab server and the Home Assistant machine lack the CPU instructions the speech models need (§0). Desk speech to text is off whenever the desktop is, and so is the desk. The phone line still needs the central one. |
| §11 Voice server reachable only by the lab server                       | The desk client reaches it on loopback                                                    | Same machine.                                                                                                                                                                                                            |
| §12 Barge-in needs a prototype per channel                              | Headphone output: any sustained speech interrupts. Other outputs: the wake word only      | Headphones put none of the reply into the microphone, so there is no echo to cancel. Open speakers stay on stop-by-word.                                                                                                 |
| Listening continues only when asked (ticket `when-listening-continues`) | The microphone stays open after every reply                                               | Parker's later ruling for this slice. Silence or an end phrase closes it.                                                                                                                                                |

## Rules the client keeps

- **Tier from the output device.** `personal` only when the output is a configured headphone
  device. The client reads the output device once, at start, and plays to that device, so the tier
  always describes where the audio goes. A changed default output takes effect on restart.
- **What she said is what he heard.** An interruption reports the words that were played, counted
  from the audio, so the head's memory of the exchange matches his.
- **Idle is silent.** Nothing reaches the head until the wake word fires.
- **Failures are spoken.** A stalled pipeline or an unreachable head ends the conversation with a
  spoken apology.
