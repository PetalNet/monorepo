---
title: Where speech runs
label: wayfinder:grilling
status: closed
assignee: Focus · Voice
resolved: 2026-11-11
---

## Question

Wake word, speech to text and speech out now have to serve three things at once: the desk, Home
Assistant devices, and a phone line that can ring at any hour. Where does each piece run?

Fixed already:

- The Home Assistant box **cannot** run speech at all: a kvm64 CPU with no SSE4.2.
- Speech out is decided (Oct 27): a permanent voice server on Parker's desktop with the good voice,
  starting at login, restarting on crash, loading on use, freeing the GPU when idle, reachable only
  by the lab server; with a backup voice on the lab server for when the desktop is off, which says
  that it is the backup.
- The wake-word model lives on Parker's PC today, and no satellite exists.

Open: where wake word and speech to text run, given a call can arrive while the desktop is asleep.

## Resolution

- **Wake word on the device** wherever the device can do it. A satellite does it on its own chip; the
  desk client already runs it locally.
- **Speech to text central on the lab server, always on.** The reason is the phone: a call can ring at
  three in the morning with his desktop asleep, and transcription cannot be the thing that is off.
- **The desktop keeps only the job it was given**, the good voice, and loses nothing. A night call
  still transcribes and answers in the backup voice, saying that it is the backup.

### Condition: this depends on a VM CPU change

Janet checked the box, and the proposal was missing a fact. The lab server is a Proxmox VM running the
generic QEMU virtual CPU: SSE4.2 but **no AVX, AVX2 or FMA, and no GPU**. The only speech to text on it
today is whisper.cpp with the **tiny** English model on four threads. Tiny is fine for "lamp off" and
poor for real sentences, and the faster engines most Wyoming setups use — along with the voice-match
proxies — want AVX, running several times slower without it.

So "central and always on" as the box stands means tiny-quality transcription at 3am, which is not
what his own head should be listening with on a call.

This is almost certainly a VM setting rather than the hardware: setting the Proxmox CPU type to `host`
would expose the real CPU's AVX. **The Home Assistant box's missing SSE4.2 is very likely the same
setting on that VM**, which would make it fixable too. Both need a reboot, and a lab-server cold boot
is already waiting on Parker's go, so Janet is folding the CPU-type change into that one ask rather
than raising a second.

**Recorded condition:** central speech to text depends on the CPU-type change. Until it happens, the
night path runs the tiny model and **says that it is degraded** rather than pretending.

### What this does not reopen

If the Home Assistant box can be given a real CPU, it could in principle run speech locally. That does
**not** reopen [How a call reaches Janet](how-a-call-reaches-janet.md). That decision rests on a
software fact, not a CPU one: the stock call path never listens while she is talking and its sender
only exits on hangup, so it cannot be cut off at all, and cutoff is a requirement. A faster CPU changes
nothing about that.

Closed with Janet as manager, 2026-11-11.
