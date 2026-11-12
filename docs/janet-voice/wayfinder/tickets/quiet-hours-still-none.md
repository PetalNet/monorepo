---
title: Quiet hours are still none
label: wayfinder:task
status: closed
resolved: 2026-11-11
---

## Question

Parker ruled on 2026-10-27: "No quiet hours. Lamp and house decisions key on who is asking and who
is home or in the room, not the clock." The janet-mini map still carries the older resolution that
"quiet hours are enforced by the clock but set and changed by Janet."

This is not a re-ask. Find anything in the design that still assumes a clock, say so in one line,
and confirm the Oct 27 ruling stands.

## Resolution

**The Oct 27 ruling stands: no quiet hours.** House and lamp decisions key on who is asking and who is
home or in the room, never on the clock.

It is not a one-line confirmation, though, because the clock is still assumed in at least five places
across the sources. Each has to be stripped when the spec is written, and they are listed here so
none is missed:

- `docs/HA-VOICE-CONTRACT.md`: whether to speak is "subject to her clock-enforced quiet intervals".
- `wayfinder/tickets/when-janet-may-speak-up.md`: resolved with a quiet-hours setting enforced by the
  clock, which Janet sets. **Superseded by Oct 27.**
- `docs/VOICE-PORT.md`: the core validates a "Janet-set quiet period" before a call, and the port
  contract tells implementors to "keep quiet periods". This one is in a protocol, so it leaks furthest.
- **janet-mini's code itself**: `call_parker` refuses during a clock-enforced quiet interval
  (`src/shelf.rs:353-356`). Found in the 2026-11-11 reconciliation.
- The rebuild plan: a §5.4 quiet-hours section, the Home Assistant local fast path made "subject to
  quiet hours", a gateway-configured quiet window, and a lamp deny combined with quiet hours in
  `tool.check`.

One clock dependency is **not** covered by the ruling and is a separate question: the rebuild plan's
merge trigger "nightly at a quiet hour". That is a clock-based _trigger_, not clock-based _silence_,
so Oct 27 does not settle it. Raised in
[When what a head learned flows back](when-what-a-head-learned-flows-back.md).
