---
title: How fast a reply must start
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

What is the latency target, measured from Parker finishing a sentence to the first word coming back,
and does it differ between a room speaker and a phone call?

Measured so far: a warm head answered in 0.5 to 1.0 seconds against 2.7 to 3.5 for a cold one; the
voice server makes 7 to 8 seconds of speech in 2.6 to 2.9 seconds warm, with time to first chunk
still unmeasured; the retired handoff gave up after 45 seconds. A phone call is less forgiving than
a speaker, because silence on a line reads as a dropped call.

Set the number the design has to hit, and what happens when it is missed.

## Resolution

Already settled; Parker flagged the re-ask ("Wasnt that quesiton baked into what we worked on in the
specs and voice?") and he was right. Checked and recorded rather than asked again:

- The acknowledgement behaviour is in the HA voice contract: a `flush` "ends the current clause,
  including Janet's own optional acknowledgment before escalation", and the manager separately
  confirmed "no fixed acknowledgment phrases per tool". So she speaks before the slow thing, in her
  own words.
- A sub-second preference was read into the janet-mini "fresh fork or fork kept ready" decision, taken
  on measurements of 0.5 to 1.0 s warm against 2.7 to 3.5 s cold. **That preference is ours, not his.**
  So is the "0.7 to 1.5 s bar" quoted elsewhere in this map: it is a janet-mini plan target
  (`PLAN.md:200`). **Parker's own stated tolerance is "3 seconds is pretty damn good"** (Oct 7), and on
  2026-11-11 he accepted about four seconds for a conversation's first turn.
- Spoken length is settled separately: short by default, answer first, up to three initial items.

What remains is a measurement, not a decision: time to first audible sound out of a speaker, still
unmeasured, plus the TTS speed gate of 0.5x realtime. That belongs to whoever builds it. Folded
into [Cutting her off](cutting-her-off.md), which needs the same instrumentation.
