---
title: One shared head, or one per call
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

Is there one voice head kept warm and shared, or a fresh one per conversation?

- The janet-mini map ruled one kept ready, measured: a new fork took 2.7 to 3.5 seconds, a running
  one 0.5 to 1.0.
- The phone line project says the opposite for calls: "incoming calls will get a janet fork with
  limited context and tools", one per call, scoped by who is calling.
- The Nov 6 page splits it by channel: a warm fork for a private channel, a fresh head built in code
  for the house speaker, a fresh public-only head for a guest.

Decide whether warmth or isolation wins where they conflict, and who pays the cold-start cost.

## Resolution

**One warm head per conversation**, not per channel and not per device. His channels share it while
the conversation carries across them, and a genuinely simultaneous second conversation forks its own
head.

Janet opened on a lean the other way, one head per channel session, to stop a phone turn carrying desk
context somewhere unexpected. The argument that moved it: inside his own trust level there is no fence
to breach. The desk on headphones and his signed-in phone are both his own head with full context, so
sharing between them costs nothing in safety, while splitting costs two things already ruled for:

- **One Janet through many doors, in the first person.** Walking from the desk to the phone continues
  the conversation rather than meeting someone who has forgotten it.
- **The warm start the kept-ready fork exists for.** Half a second against nearly three and a half,
  which matters most exactly when a call connects, because silence on a line reads as a dropped call.

Concurrency is the real constraint, and it is what "per conversation" answers: a head takes one turn
at a time, which broke in the Hermes channel spike, so two live conversations cannot share one.

### The condition, recorded as part of the decision

**Trust is re-checked every turn, against the channel that turn arrived on, and is never inherited
from the conversation.** A conversation that began on desk headphones and continues on a speakerphone
has that turn go to the room head under the drop rule, shared conversation or not. Same rule as
headphones coming off at the desk. Written down so that "shared head" is never later read as "shared
trust".

Closed with Janet as manager, 2026-11-11: "You're right, and I'm dropping my lean."

## Provisional, 2026-11-11

The warm-start half of this decision depends on fork cost, which is unverified: a fork has no cache of
its own and reads main's cached prefix, which expires after minutes of quiet. The "half a second
against nearly three and a half" comparison therefore holds only while main has spoken recently. The
*per conversation rather than per channel* half stands on its own, since it rests on trust levels and
on a head taking one turn at a time. See [What a fork actually costs](fork-cost.md).

## Rewritten by the reconciliation, 2026-11-11

**The fork trigger is the kind of request, not the shape of the exchange.** Parker's Oct 28 ladder —
"no-model -> hiku quick limited very low thinking -> janet fork -> send to janet for a later text
reply" — reserves the fork for **feature requests, complex ideas, or long conversation**, and routing
is re-decided **fresh every turn with no sticky rule** (Oct 7).

So "one warm head per conversation" was the wrong frame: a conversation does not get a fork *because*
it is a conversation. **Rung 1 answers, and passes up when the request needs rung 2.** What survives
of this ticket is narrower and still true: once rung 2 exists it is shared across his channels for that
conversation, and a genuinely simultaneous second conversation gets its own, because a head takes one
turn at a time. The trust condition also survives unchanged — trust is re-checked every turn against
the channel it arrived on.

A welcome consequence: **the cold-start worry dissolves.** The four seconds are paid behind an answer
rung 1 has already started, which is what janet-mini measures (acknowledgement 1.499 s, fork answer
3.225 s).
