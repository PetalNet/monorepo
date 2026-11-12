# The Janet voice system (wayfinder map)

label: wayfinder:map · tracker: local markdown (this folder) · charted 2026-11-11 by Focus · Voice

## Destination

Parker talks to one Janet by voice from every Home Assistant voice device he has and from a phone
number anyone can call, and she can do everything Janet can do. Reaching the end of this map means a
consolidated spec plus this decision map, enough for main Janet to build the voice head from without
asking Parker again.

## Reconciled, 2026-11-11

Janet compiled every past voice ruling word for word plus what janet-mini does in code:
the compiled record (held outside this repo). The reconciliation found **three errors of mine**, two of which
had already reached Parker, and **one provenance problem** in the most security-relevant rule in the
spec. All four are corrected in place, and the three misattributions are listed in the banner at the
top of [SPEC.md](../SPEC.md) so a cold reader meets them before trusting the rest.

In short: I quoted a manager's gloss as Parker's own words on zero idle; I treated a janet-mini plan
target as his latency requirement when he had already said three seconds was "pretty damn good"; and
the spare I costed at $3/day and called a rule violation was not the spare that existed — janet-mini's
is a prestarted process making no model calls, which is zero-idle-compliant and buys about half a
second for free. His no-spare decision stands, but he made it against an overstated premise.

**Parker was right that we had had this conversation.** Almost everything tonight was already decided
in Oct 7, Oct 19, Oct 27-28 and Nov 6. Only two things were new: the measured four-second fork start,
and the no-spare call.

**The Nov 6 tiers page's open questions are all answered**, four by this session and four by rulings
Parker had already given. the audit folded into SPEC.md §5 checks each one. **Nothing on that
page needs to go to him.**

**What is actually left** is narrower than it looked all evening: one flagged tension (Oct 19 says a
non-Parker call gets "a janet fork with limited context and tools", but a fork cannot drop context,
which is why Nov 6 chose a fresh session — ask only if the spec comes to depend on it), one engineering
list (which tools rung 1 carries), two purchases, and a reboot. Plus one **pitch**: voice as sufficient
proof for money, where a demonstrated clone attack contradicts the premise his own ruling rests on.

## ⏸ Was paused, 2026-11-11

Parker asked for all prior context to be gathered before the effort continues, having pointed out that
much of tonight restates his Oct 28 voice map. The spec is paused, skeleton included. Janet is pulling
every past voice ruling word for word plus what janet-mini does in code; work resumes from that brief.

**Root cause, recorded so the fix is structural rather than a resolution to try harder:** this
effort's source list contained no DMs. Three of Parker's rulings turned out to live only there —
consent, the 44k fork premise, and the fast-session map. The pattern was identified after the first
one and still not acted on. **Any future brief for an effort like this must include his DMs, or say
explicitly that it does not.**

### Checklist handed to Janet for the reconciliation

Tonight's decisions most likely to be already answered by Oct 28, in the order worth checking:

1. [Is there a non-fork quick tier](tickets/is-there-a-non-fork-quick-tier.md) — already reopened by
   his command-session ruling; Oct 28 probably settles it outright.
2. [One shared head, or one per call](tickets/one-shared-head-or-one-per-call.md) — Oct 28 reportedly
   reserves forks for feature requests, complex ideas and long conversations. That is a **fork
   trigger** this map does not have, and it may replace the per-conversation rule.
3. [When what a head learned flows back](tickets/when-what-a-head-learned-flows-back.md) — "anything
   important or blocking went to main" is a routing rule that touches this directly.
4. [Which model a voice head runs](tickets/which-model-a-voice-head-runs.md) and
   [Which sessions exist](tickets/which-sessions-exist.md) — whether Oct 28 already names the session
   kinds, and in what words.
5. [When the warm head is replaced](tickets/when-the-warm-head-is-replaced.md).

And three things left provisional or foggy that Oct 28 may simply answer: the command shape's limited
tool list, the pass-up trigger, and the command-to-conversation escalation boundary.

## How this effort is run, from 2026-11-11

Parker: "Janet. you and voice focus should have this conversation. janet ask me privately if we hit
something that needs me or you are unsure of." So decisions are worked with Janet as manager, and
only what is genuinely his is escalated, by her, in his DM. A purchase always goes to him.

Rulings of his have twice turned out to live only in a DM while a published page said the opposite,
and the page won by being easier to find. Janet will mark the old voice plan pages superseded and
point them here, so this spec is the one place the rulings live.

## Notes

- Domain: Home Assistant Assist as the front door, the janet-mini prototype it replaces, main Janet
  on the lab, and a phone number with its own call control.
- Janet's own cutover to Hermes (`PetalNet/hermes-cc-link`) comes first. Design for Janet-on-Hermes;
  anything that only works on today's Claude Code runtime is temporary.
- This map plans; it does not build. Main Janet builds from it.
- Parker decides. One question per message, in a Matrix poll, with a recommended answer and one line
  of why. At most three options. Plain prose: his client shows markdown raw.
- **Aggregate classification.** A fact's class is not enough on its own: a public fact answered on
  demand, repeatedly, can leak a private one. Non-private heads answer from a fixed script wherever a
  computed answer would become an oracle — but only for heads **below the rung that unlocks the
  fact**, so a matched voice still gets real answers in its own band. See [What a stranger gets on the
  phone](tickets/what-a-stranger-gets.md).
- Settled before this map opened, do not re-ask: voice on every device; all device voice through Home
  Assistant; the voice head replaces janet-mini; no quiet hours (Oct 27); private things may be spoken
  on headphones and calls, never a room speaker; voice drives the lamps directly and everything
  else goes through main Janet; a voice approval on a private channel is enough, with no carve-out for
  money, sending as Parker or deletions; code public in this monorepo, house config private.
- Each ticket must be checked against those rulings, the decisions below, and the old janet-mini map
  before it is asked. Where two sources disagree, quote both sides and let Parker pick.
- The repo is public: no addresses, serials, MAC or IP addresses, other people's names, or tokens.
  Devices are described by kind.

## What backs a decision

Parker, 2026-11-11: "every decision needs to be research backed." So every decision carries its
backing, in the Nov 6 page's own style, and reasoning is never quietly promoted to fact:

- **Research** — Janet reading code, docs or the live system, with versions and citations. Six
  decisions: what Home Assistant can own of a call, whether it can be cut off, where speech runs, what
  presence and identity exist, the front door, and the satellite hardware.
- **Parker's ruling** — his call, which outranks research rather than falling short of it. Four: the
  destination, consent, no quiet hours, and cutoff as a requirement.
- **Reasoning** from the other two. Six, and this is the group the rule bites on. All six went out for
  verification, and a verdict against one reopens it rather than footnoting it. Two are back, both
  **partly supported**, with the unsupported halves now labelled as reasoning rather than quietly
  carried.

A second standing obligation came out of the prior-art pass: **main never reads untrusted words
directly.** Anything from a room or guest head, and anything his own head wrote after reading guest
content, reaches her as a fixed-schema digest from a tool-less quarantined model. Under FIDES a
context's label is the worst label in its history, and main's session is long-lived, so a single raw
untrusted line would taint her permanently.

A standing obligation came out of the first pass: **the spec must require a pre-launch eval** of about
50 real utterances plus injection strings against each head's exact tool schema. Until it exists, the
cheap-model choice is reasoning, not research.

The fork research came back **against** three decisions and they were reopened. A first fork turn
costs about four seconds warm or cold. The "0.7 to 1.5 second bar" they were measured against is
**ours** (janet-mini `PLAN.md:200`), not Parker's — his stated tolerance is "3 seconds is pretty damn
good" — and he has since accepted the four seconds. His zero-idle wording is **"Nothing calls a model
while Parker is silent. Idle must cost zero usage."**; the longer list naming warmups and keepalives is
a manager's gloss and was wrongly quoted as his. See
[What a fork actually costs](tickets/fork-cost.md).

## Decisions so far

- [Name the destination](tickets/name-the-destination.md): one Janet by voice on every Home Assistant
  device and on a phone number; the phone line is inside this map, not a separate effort
- [What Home Assistant can own of a call](tickets/what-hass-can-own-of-a-call.md): one satellite per
  call, pipeline startable and stoppable mid-call, no barge-in as shipped, no trunk, no keypad, no
  transfer, and rights that cannot be scoped per caller; the phone primitives need a layer underneath
- [Who is speaking](tickets/who-is-speaking.md): tiered, voice match as the base rung and phone
  presence above it; voice match is free software on hardware he owns; the fused "he is alone" top
  rung is dropped, because the room's only sensor does not cover the whole room
- [How fast a reply must start](tickets/how-fast-a-reply-must-start.md): already settled in the specs,
  not re-asked; she acknowledges in her own words before the slow thing, and the warm-fork decision
  already bought the sub-second path. What is left is a measurement, not a decision
- [What counts as consent](tickets/what-counts-as-consent.md): already ruled on Oct 28 and never
  published; voice approves when it is him, headphones and calls carry approval, a speaker sends him
  to his phone, and the three always need a tap. The Oct 27 "nothing spoken is consent" rule and R4
  are retired
- [Can Home Assistant carry the audio and still be cut off](tickets/can-hass-carry-the-audio.md): no
  for calls, and in a room only with firmware we write; shipped satellites stop by word only, and
  cancelling via a new pipeline cancels nothing audible
- [How a call reaches Janet](tickets/how-a-call-reaches-janet.md): Home Assistant decides and routes
  everywhere and carries device audio; our gateway carries call audio; a phone layer underneath does
  transfers, keypad and dial-out; Janet gates callers herself. First slice is desk headphones plus
  his phone, nothing to buy
- [Which sessions exist](tickets/which-sessions-exist.md) **(amended twice on 2026-11-11)**: heads split by trust, never by device, so
  R1's client split is retired and replaced; his own head, a room head and a guest head; a head cannot
  forget, so dropping trust hands off to a fresher head with only the spoken request and cuts her off
  aloud; a bare caller id tops out at the room head; approvals only from his own head
- [One shared head, or one per call](tickets/one-shared-head-or-one-per-call.md) **(provisional)**: one warm head per
  conversation, shared across his own channels, a simultaneous second conversation forking its own;
  trust is re-checked every turn against the channel it arrived on and never inherited
- [Which model a voice head runs](tickets/which-model-a-voice-head-runs.md) **(provisional)**: the model follows the
  head; his own head is a fork on main's model for the cache, the room and guest heads are fresh
  contexts on the cheap model, and there is no second identity. Capability comes from the tool list
  built in code, never the prompt
- [Where permissions are enforced](tickets/where-permissions-are-enforced.md): reach is structure,
  conduct is judgement, and the test is whether getting it wrong leaks or spends. A non-admin HA
  account is **not** the fence; the fence is our per-head tool list plus one HA assistant per tier
  with only its entities exposed. Lamps reachable for his head and the room head, not the guest head
- [When what a head learned flows back](tickets/when-what-a-head-learned-flows-back.md) **(reopened and replaced on 2026-11-11)**: every turn
  appends its own line, since a voice conversation never announces it is over; main reads his head's
  lines as her own memory, and a room or guest head's lines reach her only as fixed-schema digests from
  a tool-less quarantined model, never raw. The nightly merge is killed for waking a model while he is
  silent
- [Where speech runs](tickets/where-speech-runs.md): wake word on the device, speech to text central
  and always on because a call can ring at 3am with the desktop asleep, and the desktop keeps only the
  good voice. Conditional on a Proxmox CPU-type change, without which the night path runs the tiny
  model and says it is degraded
- [What a stranger gets on the phone](tickets/what-a-stranger-gets.md): intake only, no client tier;
  she says she is an assistant and that the call is transcribed; a message in fixed words, never live
  free/busy, never a transfer without his rule; capped per unknown number per day. Establishes the
  spec-wide rule that a public fact answered on demand can leak a private one through repetition
- [When something is down](tickets/when-something-is-down.md): every failure fails closed on trust and
  loud on capability, but an outage drops only the proofs that depend on the broken thing, so a
  credential-proved channel survives Home Assistant being down. Loud means once per outage per
  channel. The journal is strict: she refuses work she cannot record
- [Is the cheap model good enough](tickets/cheap-model-floor.md): **partly supported**. Nothing is
  published on the cheap model for short spoken commands, and it is about four points worse on
  injection without safeguards. The decision stands because the fence is the tool list, not the model,
  so a compromised untrusted head can reach almost nothing. Requires a pre-launch eval of ~50
  utterances plus injection strings
- [Does admitting degradation help](tickets/failure-honesty-evidence.md): **partly supported**.
  Disclosure over silent degradation is backed (PAIR, HAX, Kocielnik 2019, Mahmood 2022); "once per
  outage" has no evidence and is labelled reasoning. Every degraded turn is logged even when nothing
  is said aloud
- [Tiered isolation as a pattern](tickets/tiered-isolation-prior-art.md): **supported** (OWASP LLM06
  and the Agentic Top 10, Meta's Rule of Two, CaMeL measuring the cheap quarantined model at ~1%
  utility cost and ~12% saving). The three heads each hold exactly two of untrusted input, sensitive
  data and the ability to act, which is why the architecture holds. Forces the room head down to
  public facts plus lamps, with no private facts at all
- [Provenance and taint in agent memory](tickets/provenance-and-taint.md): **partly supported, and it
  found a hole.** Quoting marks a line without stopping an injection, and under FIDES a context's label
  is the worst in its history, so it never untaints. Main reads only fixed-schema digests produced by a
  tool-less quarantined model. This reopened and replaced the journal decision, and corrected the rise
  rule written the same day
- [Measuring fork staleness](tickets/staleness-signal.md): **partly supported.** Context fullness is
  standard (MemGPT at 70 and 100 percent); fork drift from a parent has no prior art and is labelled
  **novel**. Compaction is machine-readable as a `compact_boundary` event, and the spare retires at the
  cache lifetime and whenever main's tool list changes
- [Is there a non-fork quick tier](tickets/is-there-a-non-fork-quick-tier.md): no extra rung; the
  middle rung is a head, not a speed. Collapsed into the ticket above
- [Quiet hours are still none](tickets/quiet-hours-still-none.md): the Oct 27 ruling stands, and five
  places in the sources still assume a clock, listed for stripping. One clock-based merge trigger is
  a separate question, not covered by the ruling

## Open tickets

24 of 27 are closed. Nothing is blocked by another ticket; what remains is blocked by the world.

- [Cutting her off](tickets/cutting-her-off.md) — **prototype.** The requirement is Parker's and
  settled; the proof is not. Needs real hardware, per channel, before the spec promises it.
- [Registering the number](tickets/registering-the-number.md) — **task, needs Parker.** His money and
  his identity information. Critical path for everything phone-shaped.
- [Which satellite hardware](tickets/which-satellite-hardware.md) — **deferred to the room slice.** A
  purchase, so it goes to Parker with a price, together with the question of whether a room speaker
  needs full barge-in at all.

## Open facts others own

- **The Proxmox CPU type on both VMs.** The lab server presents a generic QEMU CPU with no AVX, and
  the Home Assistant box is missing SSE4.2, very likely the same setting. Fixing it unlocks real
  speech to text and usable voice match. Janet is folding it into the cold-boot ask she already has
  open with Parker.
- **Registering the phone number.** Parker's go, his money and his identity information. Janet is
  taking it to him as its own ask. Critical path for everything phone-shaped.
- **A satellite purchase**, when the room slice comes up. Goes to Parker with a price.

## Not yet specified

- Wake word on a phone, and whether a phone is a satellite or an app.
- Enrolling anyone but Parker, and what a housemate's voice may do once the room head exists.
- How much of the subscription voice may spend, and what it does when the budget runs low. Needs
  Parker.
- Janet as switchboard: placing a call for Parker and staying on as the operator so "please hang up"
  works.
- Anything visual (the desk guide milestone) riding on the same session.
- Which tools make rung 1's limited list. An engineering list, not a decision for Parker.

*Cleared from this section: the cold-fork acknowledgement problem. It dissolved once Parker's ladder was
reconciled — rung 1 answers immediately and passes up, so rung 2's four seconds are paid behind an
answer already in progress. The room-tier acknowledgement candidate that was filed here is struck, not
deferred: it would have fed his private words into a cheap head, and an acknowledging head that hears
nothing is functionally canned.*

## Out of scope

- A separate assistant persona (Patrice): retired, there is one Janet.
- Any brain that needs an API key: every head runs on the Claude subscription.
- Listening with no wake word, no opened conversation and no explicit request for an answer.
