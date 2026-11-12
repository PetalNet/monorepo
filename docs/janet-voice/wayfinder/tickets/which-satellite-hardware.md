---
title: Which satellite hardware
label: wayfinder:grilling
status: open
deferred: later slice; needs a purchase, so it goes to Parker with a price
---

## Question

Where cutoff needs hardware help, and what to buy when it does.

### Not the starting point

Correction from Janet, 2026-11-11: Parker is not satellite-less in practice. The desk already runs a
Windows client that uses Home Assistant for wake word and speech to text, with the `hey_janet` model
on his PC, and **he wears headphones there**. Headphones mean no speaker-to-microphone echo at all,
so barge-in at the desk needs only our client to keep listening while she talks. No echo-cancelling
hardware. A phone call is the same case: the line gives a clean stream and our gateway carries it.

So the first slice is the desk on headphones plus his phone, with real cutoff on both, and nothing to
buy. See [How a call reaches Janet](how-a-call-reaches-janet.md).

### What is actually deferred

A room satellite is the only place echo cancellation in hardware matters, because neither Home
Assistant nor ESPHome has any and her own voice returning through an open microphone reads as Parker
cutting in. The stock fit is the official Voice Preview Edition, which cancels echo on its XMOS chip,
plus custom firmware to hold the microphone open through playback instead of stopping at end of
speech.

Two things to put to Parker together, when the room comes up, because one of them costs money:

1. Which hardware, and how many rooms on day one, with the price.
2. **Whether a room speaker needs full barge-in at all.** Stop-by-word is already shipped and may be
   enough there, given private things never play on a room speaker by his own ruling. Do not assume
   full barge-in in a room; ask.

Also open: whether the desk stays a Windows client or becomes a satellite like the rest.
