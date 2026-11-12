---
title: What a fork actually costs
label: wayfinder:research
status: closed
assignee: Janet
handed-off: 2026-11-11
resolved: 2026-11-11
verdict: NOT supported — against us
blocks: one-shared-head-or-one-per-call, when-the-warm-head-is-replaced, which-model-a-voice-head-runs
---

## Question

The load-bearing assumption under three closed decisions, never verified: that forking main's session
is cheap and costs no model turn, and that the child reuses her cached context rather than re-reading
it.

- What the Oct 28 `/gfork` spike actually proved, and what it only assumed.
- How long a fork takes on the harness we will actually have, not the prototype's 2.7 to 3.5 seconds.
- Whether holding a pre-forked spare costs anything while it sits idle.
- **If a fork needs a warm-up turn, that is idle usage, and it becomes Parker's decision rather than
  ours.**

## What Janet found before the ticket was even written

**A fork has no cache of its own.** It reads main's cached prefix, and that cache expires after a few
minutes without traffic — five by default, up to an hour on the longer setting. So a fork is cheap and
fast **only while main has spoken recently**. If main has been quiet longer than the window, the first
fork turn pays the whole prefix again, at full write price, with time to first word in seconds rather
than half a second. A spare taken while main was busy goes cold the same way, and keeping it warm
would mean touching the cache on a timer, **which is idle usage by definition**.

The spike's 44k cached tokens were therefore probably measured warm. Janet is getting the documented
cache lifetimes and pricing, how the fork builds its request, and what the spike really measured, and
will bring back numbers for warm and cold.

## The consequence already visible

The 3am call is the worst case on both counts: main has been silent for hours, so his own head is
cold exactly when silence on a line reads as a dropped call. That is the same scenario used to justify
central speech to text in [Where speech runs](where-speech-runs.md).

The likely mitigation is already settled rather than new: [How fast a reply must
start](how-fast-a-reply-must-start.md) has her speaking an acknowledgement immediately when the real
answer will be slower. A cold fork does not have to mean silence. But the shape of the mitigation
waits on the numbers, and it collides with "no fixed acknowledgment phrases", so it is not free.

## Verdict: not supported. It goes against us.

**"Forking costs no model turn" is false in effect.** Creating the fork makes no API call — in the Oct
28 spike, none of 47 runs logged a model step before the first prompt. But the fork's **first real
turn is a full request over the whole context**, and Claude Code appends about **20k fresh tokens on
resume** (prompt snapshot, tool list, MCP instructions, reminders), which is a cache write even when
main is warm.

Measured, Oct 28 spike: a 159k-token synthetic main on Opus 5.5, five runs per arm. Spike notes are
held outside this repo.

|                                   | first text   | cost   |
| --------------------------------- | ------------ | ------ |
| Warm fork, first turn             | 4.1 s median | ~$0.19 |
| Cold fork, first turn             | 3.5 s        | ~$1.36 |
| Follow-up turns in a running fork | 1 – 2.2 s    | ~$0.04 |

**No fork's first turn met the 0.7 to 1.5 second bar. Only a fresh lean session did.**

- The "44k cached and nothing new" figure this map was carrying came from the soft-merge digest on a
  small Haiku session, **never a voice fork**. It comes out of the spec.
- The spike's cold arm was simulated **by changing a nonce, not by a real idle wait**, so that half is
  labelled reasoning rather than measurement.

### Two numbers questioned, then settled

Both queried by Focus · Voice and answered by Janet the same day.

1. **The warm fork measured _slower_ than the cold one** (4.1 s against 3.5 s) while costing a seventh
   as much, which is strange enough to suspect. **Resolved: the nonce swap did invalidate** — the cold
   arm read 8.9k from cache and wrote 169.7k, the warm arm read 158.9k. So the cost gap is real and
   the latency gap is the noisy half. At five runs an arm, 3.5 against 4.1 is noise, and the honest
   reading is that **a first fork turn takes about four seconds, warm or cold**. No rerun needed to
   quote it safely.
2. **$1/day understated the spare.** Main compacted about **eleven times in the last day**; each
   compaction retires the spare under our own staleness rule, and each respawn pays another 4-second,
   $0.19 warm-up. That is roughly **$2/day in respawns on top of $1/day in pings — about $3/day**,
   before tool-list changes. Quoted to Parker as "about three a day, rough", with the method.

### Say which lever buys what

Easy to garble, so stated plainly: **the cache buys money, pre-spawning buys speed.** They are
different levers and the spare pulls both.

- The cache is why a first turn costs $0.19 rather than $1.36.
- The spare is why Parker does not wait: its first turn is **already spent**, so his actual first turn
  is a _follow-up_ at 1 to 2.2 seconds.

So about $3/day buys first word in **1 to 2 seconds instead of about 4**. "Warmth buys money, not
speed" is true of the cache alone and misleading about the spare.

And it buys **usually, not always**: eleven respawns a day means eleven short windows where a call
lands on no spare and waits the full four seconds.

### Cache lifetimes

Five minutes by default, refreshed free on each hit
(platform.claude.com/docs/en/build-with-claude/prompt-caching). Claude Code gets the **one-hour**
lifetime on a subscription for the main thread; the installed 2.1.312 binary returns 1h for main and
**5m for subagents and in-session forks**. A hit needs an identical prefix and the same model.

### Correction: the spare that was costed was not the spare that existed

janet-mini's kept-ready fork is a **prestarted process with no warm-up turn and no keepalive**
(`PLAN.md:89`; "An idle fork makes no model calls"). It is zero-idle-compliant by construction, and it
bought only about **0.5 s** (`PLAN.md:263`). The $3/day cache-pinging spare costed below was a
_different_ design, drawn up the same evening and presented to Parker as "the spare". **His no-spare
decision stands**, but it was made against an overstated premise, and the free half-second remains
available if he ever asks for faster.

### What survives, with its premise reversed

**The spare.** It was proposed because forking needed no warm-up. It is in fact the only thing that
works **precisely because forking does need one**: spawn it off the hot path, pay the 4-second warm-up
there, hold it on the one-hour lifetime with a ping just under the hour, and disable idle compaction on
it. About four cents an hour for 1 to 2 second answers. Pinging every four and a half minutes to hold a
five-minute cache would run about $11/day and loses to simply eating cold spawns.

### What this reopens

- [When the warm head is replaced](when-the-warm-head-is-replaced.md), since keeping one spare was
  only valid under the assumption that just failed.
- The slow-and-honest fallback, because **slow now means about four seconds** when the spare is
  missing.
- **Cost, which is Parker's call**, since the spare is a standing daily charge against his usage.
- **His Oct 28 ruling that real thinking happens in a fork of main.** The ruling **quotes the false
  number itself**: it says a fork costs about 44k cached tokens and nothing new, so it starts fast
  enough for voice. The ruling states its own premise and the premise failed, which makes this an easy
  and honest thing to put back to him.
- **His zero-idle ruling.** **His words are "Nothing calls a model while Parker is silent. Idle must
  cost zero usage."** _(Corrected: this ticket first quoted a longer list naming warmups and
  keepalives as his. That list is janet-mini's `PLAN.md:109`, a manager's gloss, and must not be
  attributed to him.)_ A spare that pings to hold a cache does call a model while he is silent, so the
  substance still bites — but the framing built on his supposed wording did not survive checking.

### Outcome: Parker ruled, and no exception was carved

**Parker, 2026-11-11: "4 seconds fresh is good for the beginning of the convo."** So there is **no
spare, no keepalives, and no exception to his zero-idle rule**, which stands whole. Rung 2 spawns when
a request first needs it and pays about four seconds; follow-ups are one to two. The cold-start worry
dissolved once the ladder was reconciled: **rung 1 answers immediately and passes up**, so the four
seconds are paid behind an answer already in progress (janet-mini measures acknowledgement at
1.499 s).

> ### Superseded framing — not implementation guidance
>
> What follows is how the question was put before his answer, including the $3/day spare framing whose
> premise was wrong. Kept because the correction matters.

### The shape of the ask as it was put

Not "pick a number". **Two of his own rulings collided, and the same finding removed the premise of
both.** He ruled real thinking happens in a fork, quoting 44k cached and nothing new; he also ruled
nothing wakes a model while he is silent. Now that a first fork turn costs about four seconds either
way, those cannot both hold: **a fork fast enough for voice requires precisely the warmups and
keepalives that his rule, in substance, rules out.**

So the question is whether he wants an exception carved into his own zero-idle rule for voice. The
$3/day against four seconds of silence is the follow-up, once he has said whether a fork is still the
thing he wants at all.
