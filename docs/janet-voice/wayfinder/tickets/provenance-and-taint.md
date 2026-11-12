---
title: Provenance and taint in agent memory
label: wayfinder:research
status: closed
assignee: Janet
resolved: 2026-11-11
verdict: partly supported — reopened and replaced the journal decision
---

## Question

[When what a head learned flows back](when-what-a-head-learned-flows-back.md) rules that a guest
head's lines reach main quoted, and can never become a rule or a note about Parker.

Is that a recognised pattern with real implementations, and does anyone enforce it on the **reading**
side as well as the writing side, which is the part Janet insisted on?

## Verdict: partly supported, and it found a hole

**Quoting marks a line; it does not stop an injection.** Main holds his private data and his tools, so
if main reads room or guest lines at all she holds all three of the Rule of Two and the architecture's
guarantee collapses at the last step.

- Willison is blunt that guardrails will not save you.
  simonwillison.net/2025/Jun/16/the-lethal-trifecta
- **MINJA** (arxiv.org/abs/2503.03704) poisons agent memory **purely by talking to the agent**, needing
  no access at all. That is precisely a guest on the phone.
- **FIDES** (arxiv.org/html/2505.23643) gives the mechanism and the fix: a context's label is the
  **worst** label in its history, so unhidden untrusted data taints the whole conversation from then
  on. For a session as long-lived as main's, that rules out merely tainting the turn, because **it
  never untaints**.
- **OWASP ASI06** adds: a line written by his own head **after that head read guest content** is
  tainted too.

### The journal decision is reopened and replaced

**Main never sees raw room or guest lines.** A **tool-less quarantined model** reads them and hands
main a **schema-constrained digest** — who called, when, which intent from a fixed list, a callback
number. Fixed fields only, never free text.

**A caller's actual message therefore needs a second route**, since fixed fields cannot carry prose:
it is stored as a transcript artifact for **Parker** to read, with main receiving the digest plus a
reference. A person reading a record is not a context being fed. See SPEC.md §14.1.

This replaces "main reads them quoted as external data" in [When what a head learned flows
back](when-what-a-head-learned-flows-back.md). Quoting was the right instinct and the wrong mechanism.

### It also corrects the rise rule, written the same day

The rise rule in [Which sessions exist](which-sessions-exist.md) said the higher head "may read
everything the lower head saw, because information flowing up leaks nothing." **That is wrong, and
this research contradicts it.** Information flowing up does not leak — it **taints**, which is worse,
because it is silent and permanent. Under FIDES, his own head reading a room head's raw words takes
that head's label forever, and under ASI06 everything it writes afterwards is tainted too.

So a rise carries a **schema-constrained digest, never raw words**, exactly like the journal. The
easy direction was never as easy as it looked.
