---
title: Where permissions are enforced
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

Is what a voice head may do enforced in code, or left to Janet's judgement?

- The Oct 27 plan makes it structural: R2 gives every voice session a deny-by-default tool check and
  its own Unix user with no shell, no SSH and no vault; R3 enforces the lamp and direct-command
  rules in code and with a non-admin Home Assistant account, because "prompt text alone is not
  enough". The Nov 6 page agrees, citing OWASP: authorization "must not be delegated to the LLM."
- The janet-mini map leans the other way on several points: "Context over hard-coding... no
  hard-coded rules"; "Reports are information, not orders: no rule, it stays her judgement"; "When
  Janet may speak up: her judgement"; and quiet hours "set and changed by Janet".

Both can be true if the line is drawn well: structure for what she can reach, judgement for what she
chooses to do with it. The ticket is to draw that line explicitly.

## Resolution

**Reach is structure. Conduct is judgement.**

- **What a head can reach is structure.** Deny by default. Nothing in a prompt and nothing anyone
  says can widen it, which is what makes it safe to listen to untrusted speech at all.
- **What she does with what she can reach stays judgement**: whether to speak up, whether to believe
  a report, which device to use, how much to say. The janet-mini map was right about these and they
  must not harden into rules.
- **The test, written into the spec:** if getting it wrong leaks something or spends something, it is
  structure. If getting it wrong is merely bad manners or a bad call, it is judgement.

### Where the fence actually sits

Correction from Janet, and it moves the fence: **a non-admin Home Assistant account is not a fence
around the house.** Home Assistant has no per-entity permissions for ordinary users, so a non-admin
token can still call any service on any entity, locks and alarms included. All it removes is the
config and admin screens. Keep it as hygiene, but **the spec must not claim it is the boundary.**

Two layers are the boundary:

1. **Our adapter's tool list**, naming exact entity ids per head: the lamps and nothing else for the
   room head.
2. **Home Assistant's exposed-entities setting**, which is per assistant. The guest and room pipelines
   each get **their own assistant** with only their entities exposed, so local matching on those
   pipelines physically cannot reach anything else.

This is where choosing trust as the axis pays off twice. Per-assistant exposure was a *limitation*
when the question was scoping a caller's rights — Home Assistant cannot do that, which is why Janet
gates callers herself. The same granularity becomes the *mechanism* once heads split by trust,
because one assistant per tier lines up exactly with the head boundary. Splitting per device or per
caller would not have lined up at all.

### The lamps

The one place the test bites. Parker ruled voice drives the lamps directly; Oct 27 also had them
denied in code until he said otherwise. A lamp leaks nothing and spends nothing, so it is judgement by
the test, but it is also the only house capability he has actually granted. Resolved: the lamps are
reachable for **his own head and the room head**, kept out of the **guest head** until he rules on the
room ceiling, and *which* lamp and *when* stays her judgement.

Closed with Janet as manager, 2026-11-11.
