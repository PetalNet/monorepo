---
title: Is the cheap model good enough
label: wayfinder:research
status: closed
assignee: Janet
resolved: 2026-11-11
verdict: partly supported
---

## Question

[Which model a voice head runs](which-model-a-voice-head-runs.md) puts the cheap model on the
untrusted heads, reasoning that there is no cache to protect there.

What is actually measured about quality at that tier for short spoken commands, and is there a
published floor below which it stops being usable?

## Verdict: partly supported

Janet. **Nothing is published on short spoken commands for the cheap model specifically.**

- The closest evidence is Anthropic's own prompt-injection work: Haiku 4.5 sits about a point behind
  Opus with safeguards on (2.4% against 1.4% attack success over 100 attempts), and about four points
  behind without them (12% against 8%). That is browser use, not voice, and Anthropic says plainly
  the problem is not solved (anthropic.com/research/prompt-injection-defenses).
- The tool-calling floor in the literature sits around 3B open models on multi-turn BFCL, far below
  the cheap model, so it does not bind — but nobody measures Haiku against Opus there.
- Home Assistant says only that local models with 8GB or more are "nearly keeping up" (HA blog,
  2025-09-11), and publishes no table.

**The decision stands, but its real backing is the tools-fixed-in-code condition, not the model's
quality.** That matters more than it first looks: the injection gap puts the *weakest* model exactly
where the *untrusted* input arrives. It is acceptable only because the fence is the tool list — a room
head holding lamps and nothing else, a guest head holding nothing — so a successful injection has
almost nothing to reach. The gap matters in proportion to blast radius, and the blast radius is
deliberately tiny. See [Where permissions are enforced](where-permissions-are-enforced.md).

### Two changes

1. **Deterministic matching handles the fixed scripts**, so the model only ever sees the fuzzy cases.
2. **Before launch, run our own eval**: about 50 real utterances plus injection strings, against the
   exact tool schema each head will carry.

**Label until that eval exists: reasoning, plus a required eval.** Not research-backed.
