---
title: Tiered isolation as a pattern
label: wayfinder:research
status: closed
assignee: Janet
resolved: 2026-11-11
verdict: supported
---

## Question

[Which sessions exist](which-sessions-exist.md) builds three heads on prior art the Nov 6 page cited
but this map never verified: OWASP on not delegating authorization to the model, Meta's rule of two,
and Letta's read-only blocks.

Does that prior art actually support separate contexts per trust level, and is anyone running a cheap
model for the untrusted tier the way we propose?

## Verdict: supported

- **OWASP LLM06** (excessive agency): put authorization in downstream systems rather than letting the
  model decide. genai.owasp.org/llmrisk/llm062025-excessive-agency
- **OWASP Agentic Top 10 (2026)**: per-tool least-privilege profiles, and isolating agent contexts per
  session.
- **Meta's Agents Rule of Two** is the theory underneath: a session may hold at most **two** of three
  things — untrusted input, sensitive data, the ability to change state or talk externally. **A fresh
  context resets the count.** ai.meta.com/blog/practical-ai-agent-security
- **CaMeL** (arxiv.org/abs/2503.18813) measured our cheap-model choice: running Haiku as the
  quarantined model under Sonnet cost about **1% utility** and saved about **12% of median cost**.

### The three heads are the Rule of Two

Worth stating, because it is why the architecture holds rather than a coincidence:

- **His own head**: sensitive data + ability to act, and **no untrusted input**, because proof is
  required on every turn.
- **The room head**: untrusted input + ability to act (lamps), and **no sensitive data**.
- **The guest head**: untrusted input only. No data, no actions.

Each holds two of three. Splitting by trust is what makes that true; splitting by device would not have.

### Amendment it forces

**The room head counts as untrusted input, because "probably him" is not him.** So it may hold low
private facts *or* the ability to act, **not both**, unless the action asks for confirmation. Lamps
alone are fine. Lamps plus his calendar is not.

Parker ruled that voice drives the lamps **directly**, i.e. without confirmation. So the room head
keeps the lamps and holds **no private facts at all**, not even low ones. Any low-band answer is a
**trust rise to his own head**, which already holds the data. This changes the room head from "public
and low notes" to "public only, plus lamps", and it means the room head answers from a fixed script by
construction, since it has nothing to compute from. See [Which sessions
exist](which-sessions-exist.md).
