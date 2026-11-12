---
title: When something is down
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

What Janet does when a piece is missing, and which failures are allowed to be silent.

The cases that already exist in the design: the desktop voice server is off, so speech out falls to
the backup voice; main Janet is unreachable, so a head cannot hand work up; a head dies mid-sentence;
the journal cannot be written; Home Assistant restarts mid-call; the Bluetooth dongle wedges, which
has happened three times since September, taking presence with it.

Two rules already constrain this: every turn appends its own journal line so nothing is lost when a
head dies, and a drop in trust must be audible rather than silent. The question is whether the same
honesty applies to every other failure, and what she says when the thing that failed is the thing
that would have told him.

## Resolution

**Every failure fails closed on trust and loud on capability.** Nothing quietly becomes less private,
and nothing pretends to still work.

### Only the proofs that depend on the broken thing are lost

Janet's refinement, and it corrects a cruder version of this rule. An outage drops **only the proofs
that depend on the thing that is down**, not every proof.

A call on his signed-in app or SIP credential is checked **by the gateway itself**, so Home Assistant
being unreachable does not turn that his-head turn into a guest turn. It loses the device facts and
the phone-in-the-room rung, and it keeps the credential. The earlier phrasing — "if the gateway cannot
reach Home Assistant the turn drops to guest" — conflated "cannot confirm the tier" with "cannot
confirm anything", and would have let one flaky integration demote the single channel we can actually
prove.

### Loud means once

**Told once, in the turn where it matters, plus one alert to main.** *(The disclosure rule is
research-backed; the once-per-outage frequency is reasoning — see [Does admitting degradation
help](failure-honesty-evidence.md). Every degraded turn is logged even when nothing is said aloud, so
restraint applies to speaking and never to recording.)* Not repeated announcements from a
room speaker at three in the morning while the dongle stays wedged. Once per outage per channel, and
named again only when he asks for something it breaks.

### What falls out for free

- Gateway cannot reach Home Assistant: device facts and the in-room rung go; a credential-proved
  channel is unaffected.
- The Bluetooth dongle wedges, as it has three times since September: the phone rung is gone and she
  is back to voice match only.
- Desktop voice server off: the backup voice answers and says it is the backup. Already ruled Oct 27.
- Central transcription degraded: it says it is degraded. Already ruled in [Where speech
  runs](where-speech-runs.md).

### The journal is strict

The journal is the only route work takes to main, so **if she cannot write a line she says so and
refuses the work** rather than accepting it and losing it. Fail closed, out loud, and never a cheerful
yes that evaporates.

### A head dying mid-sentence

The next turn starts a fresh head, which is already safe because every turn wrote its own line. But
she **names the gap** rather than carrying on as though nothing happened: he was mid-conversation and
will have noticed.

Closed with Janet as manager, 2026-11-11.
