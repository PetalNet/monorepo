---
title: Does admitting degradation help
label: wayfinder:research
status: closed
assignee: Janet
resolved: 2026-11-11
verdict: partly supported
---

## Question

[When something is down](when-something-is-down.md) rules that she says so once per outage per
channel rather than degrading silently. That was asserted from taste, not evidence.

Any real evidence on how people react to an assistant admitting degradation versus quietly degrading?

## Verdict: partly supported

Janet. **Disclosing beats silent degradation, and that half has real sources.**

- Google's PAIR guidebook names silent background errors as the dangerous case.
- Microsoft's HAX guidelines (Amershi et al., CHI 2019): make clear how well the system can do what it
  does.
- Kocielnik, Amershi and Bennett (CHI 2019): setting expectations *raised* acceptance of a weak AI
  rather than costing trust.
- Mahmood et al. (CHI 2022): apologies repair trust.

**"Once per outage per channel" has no evidence at all.** No study of repeated outage notices on voice
assistants was found, so that half is reasoning from taste and is labelled that way.

### One change it implies

**Every degraded turn is logged even when nothing is said aloud**, so the once-per-outage rule can
never quietly become the silent background error that PAIR warns about. The restraint is on speaking,
never on recording.

**Label: the disclosure rule is research-backed; the frequency rule is reasoning.**
