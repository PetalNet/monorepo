---
title: Which sessions exist
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

How many voice sessions are there, and what splits them?

- The Oct 27 plan's hard rule R1 splits by client: "The deck on Parker's desk is the only client
  that reaches the Parker voice session... HA Assist turns (client:"ha") go to a separate low-context
  household session" with no fork of main and no Parker memory.
- Parker's Nov 11 ruling sends every device through Home Assistant, which makes every turn an HA
  Assist turn and leaves R1 with nothing to split on.
- The janet-mini map already ruled in [One Janet, many doors] that "sessions are not per device; the
  device is a fact in the envelope", and the Nov 6 tiers page splits by trust instead: a fork of
  Central on a private channel, a fresh low-class head on the house speaker, a public-only head for
  a guest.

So: does the split key on who is speaking and how trusted the channel is, rather than which client
connected? Everything downstream (which model, permissions, merges) hangs on this.

## Resolution

**Heads split by trust, never by device.** Hard rule R1 split by client, the desk being the only
client allowed near Parker's context. That axis is gone now Home Assistant fronts everything, but R1
was protecting one thing, keeping untrusted speech away from his context, and trust is that axis
directly rather than by proxy. R1 is therefore **retired and replaced**, not merely dropped.

Three kinds of head:

- **His own head.** A fork of main with full context. Reached from the desk on headphones, his phone
  app signed in and unlocked, and a call proved to be him.
- **The room head.** Fresh, **public facts only, plus the lamps**. For a room speaker, and for
  anything where we only believe it is probably him. *(Amended 2026-11-11: it was "public and low
  notes". Meta's Rule of Two forbids holding private facts and the ability to act at once, and
  "probably him" counts as untrusted input, so since Parker ruled the lamps work directly and without
  confirmation, the room head holds no private facts at all. A low-band answer is a rise to his own
  head. See [Tiered isolation as a pattern](tiered-isolation-prior-art.md).)*
- **The guest head.** Public class only. For an unknown voice or an unknown caller.

The device never picks the head: the device is a fact in the envelope, per the existing ruling that
sessions are not per device.

They are separate heads rather than one head carrying a label per turn, because **a head cannot
forget what it already holds.**

### Changing trust mid-conversation

- **Dropping** hands off to a fresher head carrying the request as the speaker said it and **nothing
  else**: no draft answer, no tool results, no summary written by the head that held his context,
  since any of those can leak what the fence exists to stop. Anything she was saying aloud is cut off
  at the same moment, so the drop is audible as well as logical.
- **Rising** needs new proof, never a claim.

**The rise rule, written 2026-11-11** to close a gap this decision left: the drop rule was specified
in detail and the rise rule never was. A rise is judged **per turn, exactly like a drop**. The proof
must be present **on the turn that rises** and can never be claimed from an earlier one. The lower head
**gets nothing back**.

**What a rise carries depends on whether the lower head heard untrusted input.** From a head at his own
tier — proof on every turn, so nothing untrusted — raw words may go up. From a **room or guest** head,
which has untrusted input by definition, only a **schema-constrained digest** goes up. *(Refined the
same day: this first said a rise never carries raw words, which over-applied the taint rule to a head
that had nothing tainted to pass.)*

*Corrected the same day.* This first read "may read everything the lower head saw, because information
flowing up leaks nothing". That was wrong: information flowing up does not leak, it **taints**, which
is worse for being silent and permanent. See [Provenance and taint in agent
memory](provenance-and-taint.md).

### What counts as proof

- A call is him only from his own signed-in phone app or SIP credential. **Caller ID alone can be
  spoofed, so a bare number tops out at the room head.**
- At the desk, headphones are the envelope fact that makes it his own head and lets him approve. If
  the client reports output on the speakers, that turn **drops to room level**: he ruled "just
  speaker is messy".
- **Approvals only ever come from his own head.**

### Provisional

The room head's ceiling is built at public and low and **must not be widened** until Parker says
otherwise. That ceiling was a recommendation he never explicitly spoke; see
[Who is speaking](who-is-speaking.md).

Closed with Janet as manager, 2026-11-11, with her three amendments folded in above.

## Backing, 2026-11-11

Reasoning from settled decisions, plus prior art cited by the Nov 6 page but not verified by this map.
Sent for verification as [Tiered isolation as a pattern](tiered-isolation-prior-art.md).
