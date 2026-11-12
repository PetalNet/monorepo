---
title: How a call reaches Janet
label: wayfinder:grilling
status: closed
assignee: Focus · Voice
resolved: 2026-11-11
---

## Question

Parker ruled on 2026-11-11 that "all of it goes through Home Assistant", and then put the phone
number inside this map. Home Assistant has no telephony: it cannot answer or place a call, and the
box it runs on cannot run speech itself (kvm64 CPU, no SSE4.2). So the two rulings pull against each
other and he has to pick.

- Two ways in. Home Assistant is the front door for every device; the phone line reaches the same
  Janet without passing through Home Assistant. The phone research already assumes this shape: a DID
  plus self-hosted call control, with audio streamed into the voice stack.
- Everything through Home Assistant, calls included, so there is exactly one path.
- Calls use Home Assistant for the speech only, with call control outside it.

A fourth shape came from Parker on 2026-11-11: a custom tree plus adapter integration, so the call
arrives in Home Assistant as an assist satellite and the tree lives where he can see it. That merges
the first and third options: one brain, Home Assistant in front of the devices and in front of the
call, with a call-control layer underneath that Home Assistant drives. The adapter cannot replace
that layer, because a transfer, a keypad digit, voicemail detection and dialling out are trunk
primitives. This is now the recommendation, pending
[What Home Assistant can own of a call](what-hass-can-own-of-a-call.md).

This decides whether "front door" means one piece of software or one brain behind several.

## Where it stands, 2026-11-11

Research closed. Parker removed the build constraint ("we can also create any software we may
need"), then ruled that cutoff must work through Home Assistant, which rejects the turn-by-turn
cost rather than choosing a side. Asked whether Home Assistant should carry the call audio as well as the
routing, he declined to guess: "Unsure. see what janet can do about it." So the ticket now waits on
[Can Home Assistant carry the audio and still be cut off](can-hass-carry-the-audio.md). A phone
layer underneath is required either way, for transfers, keypad digits and outbound dialling.

## Resolution

Parker's merged shape, with the audio line drawn where the facts put it rather than by preference.
Every part of it he had already ruled, so it was closed with Janet as manager rather than put to him
again.

- **Home Assistant decides and routes everywhere.** It is the front door for every device and for a
  call: one place where the tree lives, one set of rules about who may hear what.
- **Home Assistant carries device audio**, as it does today.
- **Our gateway carries call audio**, because cutoff is a requirement
  ([Cutting her off](cutting-her-off.md)) and the stock call path cannot be cut off at all.
- **A phone layer underneath** supplies what Home Assistant has none of: transfers, keypad digits,
  voicemail and answering-machine detection, dialling arbitrary numbers, trunk registration, G.711.
- **Janet gates callers herself.** Home Assistant cannot scope rights per caller, only per assistant.

Closed with Janet as manager, 2026-11-11: "Agreed, close the front door that way."

**First slice, from Janet's sequencing call:** the desk on headphones plus his phone, with real cutoff
on both and nothing to buy, because headphones have no echo path and a phone line gives a clean
stream. Room satellites are a later slice and a purchase; see
[Which satellite hardware](which-satellite-hardware.md).
