---
title: Who is speaking
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

How does the system decide who is talking, and what does it do when it cannot tell?

- Home Assistant knows the device, never the voice: requests carry a device and satellite id, and
  speaker identification exists only as add-ons.
- The Nov 6 page proposes voice match plus his phone in the room plus a radar count of one, any one
  of which can lower the tier, and sends everything uncertain to guest.
- The janet-mini map left recognition open, and the Oct 27 plan's R4 says nothing arriving by voice
  counts as a verified speaker.

Settle what is required to be treated as Parker, and what a wrong guess costs in each direction.

## Resolution

Recognition is tiered, and the top rung is dropped on evidence.

Parker, asked what unlocks his schedule and lists on a room speaker: "Can we have different levels?
Voice match + phone location?" So voice match is the base rung and phone presence raises it, which is
the shape the Nov 6 page already drafted.

What Janet's survey then settled: voice match is software only and free, a Wyoming proxy sitting in
front of the transcriber in the normal pipeline, on hardware he already owns. The phone can say home
or not home today for nothing; room-level presence would need roughly one ESP32 per room at about ten
dollars plus enabling the phone's transmitter, with background reliability on his phone untested.

The Nov 6 page wanted a top rung where a room speaker speaks private things aloud once it is sure he
is alone. The only presence sensor in that room does not cover the whole room, so "alone" is exactly
the signal that cannot be measured, and it fails by undercounting, the direction that leaks. Parker's
Oct 27 ruling already said private things are never spoken on a room speaker. That ruling stands and
the proposal to loosen it is dropped.

Engineering note for the spec: the off-the-shelf voice-match proxies prefix the transcript with a
name, which breaks Home Assistant's own intent matching. The speaker must arrive as a separate fact
Janet reads, not as words in the sentence.

### Amendment, 2026-11-11

"Free software on hardware he owns" needs one qualification, found while closing [Where speech
runs](where-speech-runs.md). The voice-match proxies want AVX, and the lab server's VM presents a
generic QEMU CPU without it, so they would run several times slower than intended. Voice match is
still free and still needs no purchase, but it **depends on the same Proxmox CPU-type change** that
central speech to text does. Until that lands, treat the base rung as degraded rather than available.
