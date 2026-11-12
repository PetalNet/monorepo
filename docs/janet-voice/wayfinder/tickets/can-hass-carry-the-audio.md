---
title: Can Home Assistant carry the audio and still be cut off
label: wayfinder:research
status: closed
assignee: Janet
handed-off: 2026-11-11
resolved: 2026-11-11
---

## Question

Parker, asked whether Home Assistant should carry the call audio or only decide and route: "Unsure.
see what janet can do about it." So the front door waits on one fact rather than on his guess.

Can cutoff be made to work with Home Assistant carrying the audio, on HA 2026.5.2?

- Does any shipped Home Assistant voice satellite interrupt today? The ESPHome voice assistant and
  the official Voice Preview Edition hardware are the ones to check. If the shipped satellites
  already allow cutting in, Home Assistant carrying the sound costs nothing and the requirement in
  [Cutting her off](cutting-her-off.md) is simply met.
- Can a custom integration keep streaming microphone audio into Home Assistant while speech is
  playing, rather than discarding it as the VoIP integration does?
- Is starting a new pipeline mid-playback a supported way to cancel the running one, or an accident
  that happens to work?
- Where does echo cancellation sit, on the satellite or in Home Assistant, and does the official
  hardware do it on the device?
- How long does a cancel take to land? That is the difference between cutting her off and talking
  over her.

Handed to Janet in the room on 2026-11-11, with owned versus build called out, and with permission
to say plainly that it cannot be done.

## Resolution

Janet, from HA core 2026.5.2, ESPHome 2026.5.3, Voice PE firmware (Sep 2026) and voip-utils 0.3.5.
The answer is no for calls, and yes in a room only with firmware we write.

- **Shipped satellites interrupt by word only.** Voice PE keeps wake-word detection running during a
  reply, so the wake word or "stop" halts playback on the device. It does not start a new turn, and
  the stop word only arms about one second in, so the first second of her reply cannot be stopped.
  True free-speech barge-in exists nowhere in the shipped stack: ESPHome stops streaming the
  microphone to Home Assistant at end of speech, so Home Assistant hears nothing while she talks.
- **Cancelling by starting a new pipeline does not work.** The pipeline finishes once it hands out
  the TTS audio URL and the device plays it, so a new pipeline cancels nothing audible. It is
  incidental, not a stop mechanism. There is no stop-playback method on the satellite entity; the
  stop lives on the device, via ESPHome's own stop or abort message.
- **Echo cancellation.** Voice PE does it on its XMOS chip, including on the wake-word path. ESPHome
  in general has none, and Home Assistant core has none.
- **Cancel latency.** On Voice PE the stop is local, so roughly wake-word detection plus tens of
  milliseconds. Estimated, not measured. One forum report says stop fails when the reply plays on an
  external speaker rather than the device.
- **Calls, with Home Assistant carrying the audio: not possible without patching.** The VoIP path
  never transcribes audio arriving during a reply, clears it before the next turn, and its send loop
  only exits on hangup.

Owned, on stock hardware: stop-by-word on the device, with on-device echo cancellation. To build for
a room: custom ESPHome firmware that holds the microphone open through playback with the XMOS echo
cancellation on, runs voice detection, stops playback and starts a new turn. To build for calls: our
own gateway carrying the audio.

### Correction this forced

This map previously told Parker that the turn-by-turn limit was only a choice of the shipped VoIP
integration and that starting a new pipeline was the cutoff mechanism. Both were wrong, and the build
is larger than that implied. Corrected to him in the room the same day.
