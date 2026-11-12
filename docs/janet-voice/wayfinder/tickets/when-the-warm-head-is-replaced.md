---
title: When the warm head is replaced
label: wayfinder:grilling
status: closed
decided: 2026-11-11
blocked-by: fork-cost, staleness-signal
---

## Question

His own head is a fork of main kept warm, shared across his channels for one conversation. Forks
diverge and grow. So: when is the warm one retired and a fresh fork put in its place?

Inherited from the rebuild plan via [When what a head learned flows
back](when-what-a-head-learned-flows-back.md): "the fork's context passes a threshold" was listed as a
merge trigger, but it is really a lifecycle trigger and belongs here.

Constraints already settled:

- Replacing a head must not wake a model while Parker is silent, so a swap cannot be scheduled on a
  clock or triggered by the journal.
- A cold fork costs 2.7 to 3.5 seconds against 0.5 to 1.0 warm, so a swap during a conversation is
  expensive and a swap at the wrong moment is audible.
- A head cannot forget, so a long-lived head accumulates everything it has heard at that tier.

The old janet-mini map carried the same question and left it blocked on how forking works on Janet's
machine. On Hermes that mechanism is a spike (`/gfork`, Oct 28) and not built, so the answer may have
to be written against a mechanism that does not exist yet.

## Resolution, 2026-11-11

**Retire, never replace mid-conversation. There is no spare.** A head is retired; the next request
that needs rung 2 spawns a fresh fork and pays about four seconds, which Parker accepted. Retirement
conditions, none of which wakes a model: idle long enough that the conversation is plainly over;
context past a threshold, marked and retired at the next gap rather than mid-sentence; and main's
context having moved on, measured mechanically by a `compact_boundary` event or token growth since the
fork was taken. Guest heads are retired at hangup with no reuse across callers; room heads between
visitors.

> ### Superseded history — not implementation guidance
>
> What follows was the decision before the fork research landed. **The pre-forked spare it prescribes
> does not exist in the design.** Kept only to show why.

Agreed with Janet, but **provisional**: it rests on fork cost, which is unverified. See [What a fork
actually costs](fork-cost.md).

- **Retire, never replace mid-conversation.** A replacement is always a fresh fork of main taken when
  the next conversation starts. This also answers how a fork stays current, which the old map carried
  as its own problem: you do not update a fork, you throw it away and take another.
- **Three retirement conditions, none of which wakes a model:** idle long enough that the conversation
  is plainly over; context past a threshold, which marks it and retires it at the next gap rather than
  mid-sentence; and main's own context having moved on.
- Reaping a process is not a model turn, so the zero-idle rule does not block any of this. Nothing
  thinks; something stops.
- **Guest heads are retired at hangup, every time, with no reuse across callers**, because a head
  cannot forget and the second caller must never inherit the first one's words. Same for a room head
  between visitors. Only his own head is kept warm, which is also the only one where warmth buys
  anything.

### Janet's two mechanics

1. **"Main's context moved on" must be countable, or it is a model judgement in disguise.** Use a
   compaction on main since the fork was taken, or main's transcript growing past a fixed number of
   tokens since then. Either is checkable without a turn.
2. **Keep one pre-forked spare.** Taking the fork when the conversation starts lands the fork cost
   exactly when a call connects, the moment silence reads as a dropped line. So hold a spare, refresh
   it under the same three conditions while nothing is talking, and hand it over at connect.

### Why the spare was dropped

Mechanic 2 holds only if forking reuses the cache and asks nothing. Janet has since found that **a
fork has no cache of its own**: it reads main's cached prefix, which expires after minutes of
quiet. So a spare taken while main was busy goes cold anyway, and keeping it warm would mean touching
the cache on a timer, which is idle usage by definition. The spare may not survive the numbers.
