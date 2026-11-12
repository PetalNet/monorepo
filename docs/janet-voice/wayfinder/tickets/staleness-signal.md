---
title: Measuring fork staleness
label: wayfinder:research
status: closed
assignee: Janet
resolved: 2026-11-11
verdict: partly supported
---

## Question

[When the warm head is replaced](when-the-warm-head-is-replaced.md) proposes a compaction count or
token growth since the fork was taken as the staleness signal, chosen because it is countable without
a model turn.

Does anyone measure fork or branch staleness that way rather than by judgement, and is there a better
countable signal?

## Verdict: partly supported

- **Measuring how full a context is** is standard practice: MemGPT warns at 70% and flushes at 100%.
- **Measuring how far a fork has drifted from its parent has no prior art Janet could find.** That
  part is ours and is **labelled novel**, not research-backed.

Two facts that sharpen the signal:

- **Compaction is machine-readable.** It appears in the transcript as a `compact_boundary` event, so
  the check is cheap and exact rather than inferred.
- **The cache only hits on an identical prefix and lives five minutes by default.** A spare held
  longer than the TTL has already lost the reason it was held.

So: **retire the spare at the cache lifetime**, and **also whenever main's tool list changes**, since
that invalidates the cache anyway. Both are mechanical, neither is a model turn.
