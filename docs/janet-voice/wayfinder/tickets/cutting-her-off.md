---
title: Cutting her off
label: wayfinder:prototype
status: open
---

## Requirement

Parker, 2026-11-11: "I want the ability to do cutoff with hass." Interruption is a requirement on
every channel, not a tradeoff to be accepted away. Recorded as settled.

## Question

How it is made to work, and proof that it does.

The mechanism first proposed here was wrong, and
[Can Home Assistant carry the audio and still be cut off](can-hass-carry-the-audio.md) replaced it.
Cancelling by starting a new pipeline cancels nothing audible, and there is no stop on the satellite
entity. What the facts leave:

- **In a room:** custom ESPHome firmware on a satellite whose own chip cancels echo, holding the
  microphone open through playback, running voice detection, stopping playback and starting a new
  turn. Stock gives stop-by-word only, dead for the first second, and reportedly broken when the
  reply plays on an external speaker.
- **On a call:** our own gateway carries the audio. The stock call path never listens while she
  talks and its sender only stops on hangup.

The risk is not Home Assistant, it is acoustics, and this is the one thing that has already failed
once. The prototype shipped with echo cancellation and interruption switched off "because measured
safety gates did not pass", and echo cancellation on open speakers was never proved at all. Her own
voice returning through the microphone looks like Parker cutting in, so the system interrupts itself.
A phone call is the easier case, because the line gives a cleaner stream than a room.

Needs a prototype on real hardware, per channel, before the spec promises it: a room speaker, a
headset, and a call. The measurement that matters is false cutoffs per minute of her own speech, and
how long a real interruption takes to land.
