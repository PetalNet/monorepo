---
title: Which model a voice head runs
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

Does a voice head run main Janet's model, or a smaller one?

- The janet-mini map ruled "the fork runs the same model as main Janet at low effort, so her cached
  context is reused and voice stays quick. Fast Janet runs Haiku."
- The Oct 27 rebuild plan retires the small brain outright: "the separate small Haiku brain goes
  away", "the headless Haiku session becomes a Janet voice session on the new harness."
- The Nov 6 tiers page puts a quick model back in the ladder: "HA intent, then the quick model, then
  a fork, then Central doing the work."

Three sources, three answers. Pairs with [Is there a non-fork quick tier](is-there-a-non-fork-quick-tier.md).

## Resolution

**The model follows the head.** All three sources were right about different heads.

- **His own head** is a fork of main, so it runs main's model. The cache is the whole reason it is
  warm; giving it a different model throws that away.
- **The room and guest heads** are fresh contexts built in code. _(Backing: the cheap model's quality
  at this tier is unmeasured — see [Is the cheap model good enough](cheap-model-floor.md). The real
  backing is the tool list, plus a required pre-launch eval. Deterministic matching handles the fixed
  scripts so the model only sees the fuzzy cases.)_ There is no cache to preserve and no
  main context to reuse, so nothing argues for the expensive model and plenty argues against. This is
  where the cheap model lives.
- **There is no second identity.** Haiku survives as what the untrusted heads run, not as a "fast
  Janet" with a persona of her own, which is the part Oct 27 was right to kill.
- **There IS an independent quick rung.** _(Corrected 2026-11-11, later the same day: this ticket
  first said Nov 6's "quick model" was "not a rung", merely the room head seen from outside, and
  collapsed [Is there a non-fork quick tier](is-there-a-non-fork-quick-tier.md) into itself on that
  basis. Parker then ruled "Hey janet what is xyz should be fast limited tools culled down session",
  which restores it._ **Rung 1 is a real rung**, independent of tier: a culled-down context with a
  limited tool list. What stays dead is a separate _identity_ — there is no "fast Janet".)
- Consistent with Parker's Oct 28 ruling that real thinking happens in a fork of main, and that
  subagent work and anything important or blocking always goes back to main.

### Conditions, from Janet

1. **Capability is fixed by the tool list a head is built with in code, not by its prompt.** A room or
   guest head simply does not have his calendar, mail or approvals wired in, so no amount of clever
   speech can talk it into them. This also settles half of
   [Where permissions are enforced](where-permissions-are-enforced.md).
2. **Home Assistant keeps matching a lamp or a timer locally, with no model in the loop** — free,
   instant, and what keeps idle usage at zero. But it **obeys the same trust tier** as the head that
   turn would have gone to. For a guest voice, whether the lamps work at all is still whatever
   Parker's room-speaker ceiling decides, so local matching must not become a back door around it.

Closed with Janet as manager, 2026-11-11.

## Settled after the fork research, 2026-11-11

The cache justification weakened but the conclusion held. A fork reads main's cached prefix rather
than having its own, so "warm" buys **money, not speed** — a first turn is about four seconds either
way. Rung 2 still runs main's model, because it is a fork of her and a different model would discard
the prefix entirely, making it cost $1.36 rather than $0.19. See
[What a fork actually costs](fork-cost.md).
