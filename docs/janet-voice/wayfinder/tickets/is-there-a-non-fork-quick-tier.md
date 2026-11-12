---
title: Is there a non-fork quick tier
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
collapsed-into: which-model-a-voice-head-runs
reopened-by: Parker's ruling on command sessions
---

## Question

Between Home Assistant answering an intent itself and a fork of main Janet, is there a middle rung
at all: a cheap head with no access to Janet's context?

- The janet-mini map kept two speeds on purpose: the house answers instantly, "a small fast Janet
  handles one-off requests", the full agent handles the rest.
- The Oct 27 plan collapses that to one: Janet herself answers by voice.
- The Nov 6 tiers page needs a context-free head for guests and the house speaker, which is a middle
  rung whether or not it is called Haiku.

The question is whether the middle rung is a cost decision, a privacy decision, or both.

## Resolution

**Yes. Rung 1 is a real, independent rung** — a cheap model with a culled-down context and a limited
tool list, for voice commands and quick questions. Parker, 2026-11-11: "Hey janet what is xyz should be
fast limited tools culled down session." It is independent of **tier**: the same rung serves his own,
room and guest turns, differing in what it may hold and do.

What does **not** exist is a separate *identity*. There is no "fast Janet"; the cheap model is
something a rung runs.

### How the collapse went wrong

Parker: "Hey janet what is xyz should be fast limited tools culled down session." So a quick question
or a device command **does** get its own session shape: fresh, culled-down context, limited tool list.

That is the rung this ticket collapsed. The collapse reasoned that "the middle rung is a head, not a
speed" — **half right**. It is a head, *and* it is a speed, because he has ruled the session shape
itself differs. What stays dead is a separate **identity**: there is no "fast Janet". A **command
session** is a shape, not a persona.

The lasting fix is the distinction in [CONTEXT.md](../../CONTEXT.md): a head is a **tier** and a
**shape**, independently. The collapse happened because this map was treating one word as both.

*Still provisional, and ours rather than his:* which tools make the limited list, the command shape's
tier (set by what the channel proves), and the escalation boundary where a command that draws a
follow-up becomes a conversation and pays the four seconds.

> ### Superseded history — not implementation guidance
>
> This ticket was first closed the other way, collapsing the rung away. The reasoning below is kept
> because the distinction it got wrong is worth seeing.

**Collapsed into [Which model a voice head runs](which-model-a-voice-head-runs.md)**, with Janet's
agreement, because the trust split had already answered it.

There is no extra rung between a Home Assistant intent and a fork of main. What Nov 6 called "the
quick model" is the room head seen from outside: a fresh context on the cheap model, which exists for
privacy first and cost second. The middle rung is a *head*, not a *speed*.

So the answer to the question as posed — cost decision, privacy decision, or both — is: privacy
decides that the head exists, and cost decides what model it runs.
