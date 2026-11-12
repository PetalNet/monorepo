# The Janet voice system

> ## Read this first: how the rulings in here were checked
>
> Parker pointed out, late in the charting session, that we had already had this conversation, and he
> was right. Janet then compiled every past voice ruling of his verbatim, plus what janet-mini does in
> code (that record is held outside this public repo). **Almost everything decided on 2026-11-11 was
> already decided** in Oct 7, Oct 19, Oct 27-28 and Nov 6. Only two things were new: the **measured
> four-second fork start** and the **no-spare call**.
>
> Three misattributions were found and are corrected in place, each noted in the section it affects:
>
> 1. **His zero-idle wording** is *"Nothing calls a model while Parker is silent. Idle must cost zero
>    usage."* The longer list naming warmups and keepalives is janet-mini's `PLAN.md:109` — a manager's
>    gloss that was wrongly quoted as his. (§9)
> 2. **The "0.7 to 1.5 second bar" is ours**, from janet-mini `PLAN.md:200`, not his requirement. His
>    stated tolerance is *"3 seconds is pretty damn good."* (§9)
> 3. **A phone tap for money, sending as him and deletions was never his ruling.** The Nov 6 page
>    asserted it under a "Parker ruled" label while also listing it as its own open question, and his
>    actual words go the other way. It is removed, and the outbound-call tap derived from it with it.
>    (§8, §14.2)
>
> **Two lessons that generalise**, recorded because they caused the above: rulings of his may exist
> only in DMs, so a source list without them is incomplete; and a published page's "Parker ruled"
> label is **unverified** until matched to his words — twice it was wrong, once inverted.

A consolidated spec, assembled from the decisions in [the map](wayfinder/map.md). Vocabulary is in
[CONTEXT.md](CONTEXT.md); every term in bold there means exactly what it says there.

Charted and decided with Parker on 2026-11-11. Nothing here has been built.

**Every rule below carries its backing**, because Parker required it: `[research]` means a sourced read
of code, docs or the live system; `[ruling]` means Parker's own call, which outranks research rather
than falling short of it; `[reasoning]` means derived from the other two and not independently
verified. A `[reasoning]` rule is not a weaker rule, but it is an unverified one, and a verdict against
it reopens the decision rather than earning a footnote.

---

## 0. Open dependencies

**This system cannot be built as written today.** Three things are outstanding, two of them Parker's.
None of them blocks the first slice.

*Resolved 2026-11-11: the fork question. Parker ruled "4 seconds fresh is good for the beginning of the
convo", so there is no spare, no keepalives and **no exception to his zero-idle rule**. See §9.*

| What | Who | What it blocks |
|---|---|---|
| **The room-speaker band.** Whether voice match *plus* phone presence proves him well enough to reach rung 2 from a room speaker, and whether his schedule may then be spoken aloud there. He asked for exactly this ("Can we have different levels? Voice match + phone location?") and his Oct 27 "never on a room speaker" covers *private* things without saying whether a schedule is one. **Leans permissive** — he told Janet to look at how Google does voice matching, and Google gives a matched voice its calendar on a shared speaker — but that is an instruction to research, not a ruling, and this spec does not manufacture rulings. **Blocks only what a room speaker may say.** | Parker | §4.3, and the width of §5.3 |
| **Two purchases.** A satellite for the room slice, with a price; and the phone number's registration, about $21 and a one-to-two week vetting wait. | Parker | The room slice and everything phone-shaped. Registration is the critical path, so it should be raised first. |
| **The Proxmox CPU type on both VMs.** The lab server presents a generic QEMU CPU with no AVX; the Home Assistant box lacks SSE4.2, very likely the same setting. | A reboot | Real speech to text (§7) and usable voice match (§4.2). Until it lands, both run degraded and say so. |

**A standing obligation:** before launch, run an eval of about 50 real utterances plus injection
strings against **each head's exact tool schema**. Until it exists, the cheap-model choice in §6 is
`[reasoning]`, not `[research]`. [→ ticket](wayfinder/tickets/cheap-model-floor.md)

---

## 1. What this is

Parker talks to one Janet by voice from every Home Assistant voice device he has, and from a phone
number anyone can call, and she can do everything Janet can do. `[ruling]`
[→ ticket](wayfinder/tickets/name-the-destination.md)

The voice system **replaces janet-mini**. `[ruling]`

It is designed for **Janet-on-Hermes**: anything that only works on today's Claude Code runtime is
temporary. `[ruling]`

---

## 2. The shape of a turn

```
    speech
      │
      ▼
 ┌─────────────────────────────────────────┐
 │ Home Assistant — the front door         │  decides and routes every turn,
 │ one assistant per tier                  │  on every channel
 └─────────────────────────────────────────┘
      │  envelope: device, channel, proof
      ▼
 ┌─────────────────────────────────────────┐
 │ the gateway — code, not a model         │  judges the tier, stamps the turn
 └─────────────────────────────────────────┘
      │
      ├── matched locally (a lamp, a timer) ──► no model at all
      │
      ▼  tier selects the head
 ┌──────────────┬──────────────┬───────────┐
 │ his own head │  room head   │ guest head│
 └──────────────┴──────────────┴───────────┘
      │ journal line per turn
      ▼
 ┌─────────────────────────────────────────┐
 │ quarantined reader ──► digest           │  untrusted lines only
 └─────────────────────────────────────────┘
      ▼
   main Janet
```

**Home Assistant decides and routes everywhere.** It is the front door for every device and for a
call: one place the tree lives, one set of rules about who may hear what. `[research]`
[→ ticket](wayfinder/tickets/how-a-call-reaches-janet.md)

**Home Assistant carries device audio.** It does not carry call audio: our gateway does, because
**cutoff** is a requirement and the stock call path cannot be cut off at all. `[research]`

**A phone layer sits underneath**, supplying what Home Assistant has none of: transfers, keypad
digits, voicemail and answering-machine detection, dialling arbitrary numbers, trunk registration,
G.711. `[research]`

**Janet gates callers herself.** Home Assistant scopes rights per assistant, never per caller.
`[research]`

**Home Assistant keeps matching lamps and timers locally, with no model in the loop** — free, instant,
and what keeps idle usage at zero. It obeys the **same tier** as the head that turn would have gone
to, so local matching is never a back door around a ceiling. `[reasoning]`
[→ ticket](wayfinder/tickets/which-model-a-voice-head-runs.md)

---

## 3. Trust

### 3.1 The axis

**Heads split by trust, never by device.** The device is a fact in the **envelope**, not the selector.
`[reasoning]` [→ ticket](wayfinder/tickets/which-sessions-exist.md)

This retires and replaces hard rule R1, which split by client. R1 was protecting one thing — keeping
untrusted speech away from Parker's context — and trust is that axis directly rather than by proxy.

### 3.2 Judged every turn

**The tier is re-judged on every turn, against the channel that turn arrived on, and is never
inherited from the conversation.** A shared head never means shared trust. `[reasoning]`
[→ ticket](wayfinder/tickets/one-shared-head-or-one-per-call.md)

### 3.3 What counts as proof

| Channel | Tier |
|---|---|
| His signed-in phone app, unlocked | his own head |
| A call on his own signed-in app or SIP credential | his own head |
| The desk, **headphones** reported by the client | his own head |
| The desk, output on **speakers** | room head — "just speaker is messy" `[ruling]` |
| A call from a bare number, however it looks | **room head at most** — caller id is spoofable `[research]` |
| Voice match alone, on a room speaker | room head |
| An unknown voice, an unknown caller | guest head |

**Approvals only ever come from his own head.** `[ruling]`

### 3.4 Rise and drop

- **A drop is instant and needs no model.** It carries **only the words the speaker said** — no draft
  answer, no tool results, no summary written by the head that held his context. Anything she was
  saying aloud **cuts off at the same moment**, so the drop is audible as well as logical.
  `[reasoning]`
- **A rise needs proof present on that turn**, never claimed from an earlier one. `[research]`
- **What a rise carries depends on whether the lower head heard untrusted input.** `[research]`
  - From a head at **his own tier** — proof on every turn, so nothing untrusted — raw words may go up.
  - From a **room or guest** head, which has untrusted input by definition, only a **digest** goes up.

Information flowing up does not leak — it **taints**, which is worse for being silent and permanent.
An earlier draft of this spec said a rise could carry everything the lower head saw; that was wrong,
and the two-case rule above replaces it. `[research]`
[→ ticket](wayfinder/tickets/provenance-and-taint.md)

---

## 4. Who is speaking

### 4.1 Tiered, with voice match as the base

Recognition is tiered: **voice match** is the base rung and **phone presence** raises it. `[ruling]`
[→ ticket](wayfinder/tickets/who-is-speaking.md)

### 4.2 What it costs

Voice match is software only and needs no purchase: a Wyoming proxy in front of the transcriber, on
hardware he already owns. It **depends on the Proxmox CPU-type change** (§0); until then the base rung
is degraded, not available. `[research]`

The phone says home-or-not today for nothing. Room-level presence needs roughly one ESP32 per room at
about ten dollars, plus enabling the phone's transmitter, whose background reliability is untested.
`[research]`

**The speaker must arrive as a separate fact Janet reads, never as words in the sentence.** The
off-the-shelf proxies prefix the transcript with a name, which breaks Home Assistant's own intent
matching. `[research]`

### 4.3 No fused "he is alone" rung

The Nov 6 design proposed a top rung where a room speaker speaks private things aloud once it is sure
he is alone. **Dropped.** The room's only presence sensor does not cover the whole room, so "alone" is
exactly the signal that cannot be measured, and it fails by undercounting — the direction that leaks.
His Oct 27 ruling that private things are never spoken on a room speaker stands. `[research]`

---

## 5. Data

### 5.1 Classes

**Public**, **low** (personal, not secret), **high**, **secret**. **An untagged fact counts as high**,
so a missing tag fails closed. `[reasoning]`

**These four classes are an internal refinement and are legitimate only if they reduce to Parker's own
line**, which is simpler and already given: private things may be spoken on headphones and calls,
**never a room speaker**, and otherwise **they go to his phone**. `[ruling]` The classes were listed as
an open question on the Nov 6 page; they are not open, they are just finer-grained than his ruling and
answerable to it.

**Secret never enters any head, at any tier.** `[ruling]`

### 5.2 Aggregate class

**A public fact answered on demand, repeatedly, can leak a private one.** Classifying each fact alone
is not sufficient. Free/busy is public once and an **oracle** asked twice: a caller dialling at 10:58
and again at 11:05 learns when he is reliably unavailable, and a reliable daily pattern approximates
location. `[reasoning]`
[→ ticket](wayfinder/tickets/what-a-stranger-gets.md)

**Its boundary:** the rule binds **every head below the rung that unlocks the fact**, not every
non-private head. A matched voice still gets real answers inside its own band.

### 5.3 Say it or send it

**Private things go to his phone. She does not ask first.** `[ruling]` His Oct 27 wording is "Otherwise
they go to your phone" — they *go*; he did not say she offers. The Nov 6 page proposed an offer ("Want
it on your phone?") as its own inference; that offer is **dropped**.

### 5.4 Fixed script

Any head below the unlocking rung answers from a **fixed script** wherever a computed answer would
become an oracle. The room head holds no private facts at all, so it answers from script by
construction. `[reasoning]`

*Width pending the room-speaker ceiling (§0).*

---

## 6. The heads

### 6.1 Two axes, not one

A head is a **rung** and a **tier**, and they are independent. Conflating them caused two misreadings
on the day this was written, so it is stated first.

- **Rung** — how much machinery the *request* needs. Parker's ladder, below. Chosen by the kind of
  thing being asked, and re-chosen **fresh on every turn**.
- **Tier** — what is *proved* about who is speaking, and therefore what the head may hold and do.
  His own, room, or guest.

A command on headphones is rung 1 at his tier; the same words on a room speaker are rung 1 at room
tier. Neither axis determines the other.

### 6.2 The ladder

**Parker's, Oct 28**: "no-model -> hiku quick limited very low thinking -> janet fork ->
send to janet for a later text reply". `[ruling]` It restates the Oct 7 two-speeds ruling, and
janet-mini's code already implements exactly this.

| Rung | What | For | Measured |
|---|---|---|---|
| **0** | Home Assistant's own intent matcher. **No model at all.** | Lamps, timers | instant, free |
| **1** | Cheap model, **limited tools, culled-down context, very low thinking**. Never loads main's context. | Voice commands, quick questions — "Hey janet what is xyz" | 0.758 s median reply |
| **2** | **A fork of main**, full context, main's model at low effort. | **Feature requests, complex ideas, long conversation** | ~4 s first turn, 1–2 s after |
| **3** | **Main Janet.** | Subagent tasks, anything important, anything blocking, anything that leaves the house or deletes | spoken if back within 45 s, else a notification |

**The trigger is the kind of request, not the length of the exchange.** `[ruling]`

**Each rung decides fresh, every turn. There is no sticky routing.** `[ruling]` (Oct 7: "fast Janet
decides fresh on every one-shot turn. No sticky rule.") Only the rung below may pass up, and it does so
by calling a tool rather than by anything inferred from its text. Parker: "and they can pass up as
needed."

**A pass-up carries raw words only from a head that heard no untrusted input** — that is, one at his own
tier. A room or guest head passes a **digest** instead, by the same rule as §3.4 and §10. So a rung-1
head on a room speaker may pass up, but what reaches rung 2 is a digest, and the answer returns at room
tier unless the channel proves him. `[research]`

**This corrects an earlier draft of this spec**, which had a conversation get a fork *because it was a
conversation*. Entry to rung 2 is by request kind; a conversation that never needs rung 2 never pays
for it. [→ ticket](wayfinder/tickets/one-shared-head-or-one-per-call.md)

### 6.3 Tiers

**Each tier holds exactly two of untrusted input, sensitive data, and the ability to act** — Meta's
Rule of Two. This is why the architecture holds, and why splitting by device would not have
produced it. `[research]` [→ ticket](wayfinder/tickets/tiered-isolation-prior-art.md)

| Tier | Untrusted input | Sensitive data | Can act |
|---|---|---|---|
| His own | no — proof every turn | **yes** | **yes** |
| Room | **yes** — "probably him" is not him | no | **yes** — lamps only |
| Guest | **yes** | no | no |

**They are separate processes because a head cannot forget what it has already heard.** That property,
not convenience, is the reason there are three. `[reasoning]`

**The room head holds no private facts, not even low ones.** Parker ruled the lamps act *directly*,
without confirmation, so under the Rule of Two it cannot also hold private facts. A low-band answer is
a **rise** to his own head. `[research]`

**The model follows the head.** The room and guest heads are fresh contexts on the **cheap model**;
there is no cache to preserve and nothing argues for the expensive one. `[reasoning]`
[→ ticket](wayfinder/tickets/which-model-a-voice-head-runs.md)

**There is no second identity.** The cheap model is what the untrusted heads *run*; it is not a "fast
Janet". Nov 6's "quick model" rung was the room head seen from outside, never a rung.
[→ ticket](wayfinder/tickets/is-there-a-non-fork-quick-tier.md)

**Why the weakest model may sit where the untrusted input arrives:** because the fence is the tool
list, not the model. A compromised room head reaches a lamp; a compromised guest head reaches nothing.
The injection gap matters in proportion to blast radius, and the blast radius is deliberately tiny.
`[research]`

**Retirement.** The guest head is retired **at hangup, every time, with no reuse across callers**,
because a head cannot forget and the second caller must never inherit the first one's words. The room
head is retired between visitors. `[reasoning]`

### 6.4 What the ladder settles

**The rung this map briefly collapsed is real.** [Is there a non-fork quick
tier](wayfinder/tickets/is-there-a-non-fork-quick-tier.md) was closed on the reasoning that "the middle
rung is a head, not a speed" — half right. It is a head *and* a speed. What stays dead is a separate
**identity**: there is no "fast Janet", only a rung.

**The cold-start problem dissolves.** An earlier draft worried at length about four seconds of silence
at the start of a call, and filed a candidate for generating an acknowledgement from a room-tier head.
None of that is needed. **Rung 1 answers immediately and passes up as needed**, so the fork's four
seconds are paid behind an answer that has already begun. janet-mini measures this: the acknowledgement
lands at 1.499 s and the fork's answer begins at 3.225 s. Rung 1 speaks its own short acknowledgement
before the pass-up tool call — freshly generated, so his no-canned-phrases ruling is satisfied without
any of the machinery that draft proposed.

*Still ours rather than his:* **which tools make rung 1's limited list.*

---

## 7. Permissions

**Reach is structure. Conduct is judgement.** `[reasoning]`
[→ ticket](wayfinder/tickets/where-permissions-are-enforced.md)

**The test:** if getting it wrong **leaks** something or **spends** something, it is structure. If
getting it wrong is merely bad manners or a bad call, it is judgement.

- **Structure.** What a head can reach. Deny by default. Nothing in a prompt and nothing anyone says
  can widen it — which is what makes it safe to listen to untrusted speech at all.
- **Judgement, and it stays judgement.** Whether to speak up, whether to believe a report, which
  device to use, how much to say.

### The fence is two layers

**A non-admin Home Assistant account is *not* a fence.** Home Assistant has no per-entity permissions
for ordinary users, so a non-admin token can still call any service on any entity, locks and alarms
included; all it removes is the config screens. Keep it as hygiene. Do not treat it as the boundary.
`[research]`

1. **Our adapter's tool list**, naming exact entity ids per head.
2. **Home Assistant's exposed-entities setting**, which is per assistant — so the guest and room
   pipelines each get **their own assistant**, exposing only their own entities. Local matching on
   those pipelines then physically cannot reach anything else.

Per-assistant exposure was the *limitation* that stopped us scoping a caller's rights; it becomes the
*mechanism* once heads split by trust, because one assistant per tier lands exactly on the head
boundary.

### The lamps

Reachable for **his own head and the room head**; kept out of the **guest head** until the
room-speaker ceiling is ruled. *Which* lamp and *when* stays her judgement. `[ruling]` + `[reasoning]`

---

## 8. Consent

Ruled by Parker on 2026-10-28, in a DM that never reached the published page. The Oct 27 rule that
"nothing spoken counts as your approval", and hard rule R4, are **retired**. `[ruling]`
[→ ticket](wayfinder/tickets/what-counts-as-consent.md)

- **Approval by voice counts when it is proved to be him.** A call counts when proved by his
  signed-in app or his SIP credential — **not** by caller id, which is spoofable (§3.3).
- **Headphones carry approval**, checked against his known devices, not a name guess.
- **On a room speaker she asks him to confirm on his phone, or to put headphones on.** "just speaker
  is messy".
- **There is no carve-out for money, sending as him, or deletions.** `[ruling]` His Oct 28 words admit
  none: "from a phone call or voice as long as its me (phone 100% is) ect is enough for an approval."
  **So the phone-tap requirement is removed from this spec.** It was never his ruling; the Nov 6 page
  asserted it under a "Parker ruled" label while also listing it as its own first open question, and
  the compiled record contains only the permissive direction.

**A standing recommendation, not a question.** His ruling turns on *"as long as its me"*, and for money that premise has a demonstrated defeat: a
journalist entered his own bank account by phone using a voice clone trained on about five minutes of
speech (Cox / Lloyds, Feb 2023), and ASVspoof 2021 found replay detection did not survive moving from
simulated rooms to real ones. So voice does not establish "it's me" against a motivated attacker at the
one place where the loss is unrecoverable. That is worth **pitching** to him with the evidence
attached, exactly as the fork premise was. It is not grounds for overriding him in the meantime.

---

## 9. Speed and lifecycle

**Parker ruled it: "4 seconds fresh is good for the beginning of the convo."** `[ruling]`

- **Rung 2 is a fork of main, spawned when a request first needs it** — not at the first word of a
  conversation. That turn takes about four seconds. Follow-ups inside the running head are one to two.
- **No spare, no keepalives, and no exception to the zero-idle rule.** The rule stands intact. Nothing
  wakes a model while he is silent.
- **Retirement is simply retirement.** A head is retired; the next request that needs rung 2 spawns a
  fresh fork. No head is kept warm.
- **A rung-1 head is retired when the utterance is done**, and carries no conversation. `[reasoning]`
- **The staleness signal still decides when a *running* head is retired** — it no longer has a spare to
  schedule.
- The $3/day question is moot.

What was settled regardless of his answer:

- **She speaks before the slow thing**, in her own words, with **no canned phrases**. `[ruling]`
  [→ ticket](wayfinder/tickets/how-fast-a-reply-must-start.md)
- **"Nothing calls a model while Parker is silent. Idle must cost zero usage."** `[ruling]` — his
  words. The longer gloss naming warmups, summaries, keepalives and journal-triggered turns is
  janet-mini's `PLAN.md:109` and must not be quoted as his. **His answer kept this rule whole.**
- **Reaping a process is not a model turn**, so retiring a head costs nothing and needs no exception.
  `[reasoning]`
- **Heads are retired, never replaced mid-conversation.** `[reasoning]`
  [→ ticket](wayfinder/tickets/when-the-warm-head-is-replaced.md)
- **Staleness signals must be countable, never a model's judgement.** Compaction is machine-readable
  as a `compact_boundary` event. `[research]`
  [→ ticket](wayfinder/tickets/staleness-signal.md)
- **Measuring a fork's drift from its parent has no prior art.** That part is **novel**, not
  research-backed.

The measured numbers, for whoever writes this section: a first fork turn reaches first text in about
**four seconds, warm or cold**; warm costs about **$0.19** and cold about **$1.36**; follow-up turns
inside a running head are **1 to 2.2 seconds** at about **$0.04**. `[research]`

The "0.7 to 1.5 second bar" quoted in earlier drafts is **ours**, from janet-mini `PLAN.md:200`, not
Parker's. His stated tolerance, Oct 7: **"3 seconds is not bad at all ... 3 seconds is pretty damn
good."** Rung 1 meets it comfortably; rung 2 sits just outside it and he has accepted that.
[→ ticket](wayfinder/tickets/fork-cost.md)

**The cache buys money; having already spent the first turn buys speed.** Different levers, not
interchangeable. With no spare, the system buys neither for the first turn of a conversation and
accepts the four seconds — which is what he chose, knowing the number.

---

## 10. Memory

**Every turn appends its own journal line, as part of that turn.** Never at the end of the
conversation: a voice conversation never announces that it is over — people stop talking, a call
drops, headphones come off — so a head waiting for the end would lose exactly the conversations that
ended badly. `[reasoning]`
[→ ticket](wayfinder/tickets/when-what-a-head-learned-flows-back.md)

A line carries the words, the tier, the speaker or *unknown*, and what the head did. Appended
mechanically, **never reconciled by a separate model call**. Main picks it up on her next turn, so
nothing is lost even if a head dies mid-sentence.

**A line's tier comes from the proof on the turn, not from which head made the sound**, and **only the
head that owned the turn writes a line**. A misattributed line is worse than a missing one: it would
read later as a guest utterance. `[reasoning]`

### How main reads it

- **Lines from his own head are main's own memory.** That head is continuous with her.
- **Lines from a room or guest head never reach main raw.** A **tool-less quarantined model** reads
  them and hands main a **fixed-schema digest** — who called, when, which intent from a fixed list, a
  callback number. Set fields, never free text. `[research]`
- **A line his own head wrote *after* reading guest content is tainted too** (OWASP ASI06) and takes
  the same route. `[research]`

**Why digests and not quoting.** Quoting marks a line without disarming it. Main holds his private
data and her tools, so reading untrusted words directly would give her all three of the Rule of Two.
Under FIDES a context's label is the **worst label in its history** and never untaints, and main's
session is long-lived, so a single raw untrusted line would taint her permanently. MINJA poisons agent
memory purely by talking to the agent, which is precisely a guest on the phone. `[research]`
[→ ticket](wayfinder/tickets/provenance-and-taint.md)

**The nightly merge is killed.** A clock-triggered merge wakes a model while he is silent, which his
own rule names. `[ruling]`

---

## 11. Speech

- **Wake word on the device**, wherever the device can do it. `[reasoning]`
  [→ ticket](wayfinder/tickets/where-speech-runs.md)
- **Speech to text central on the lab server, always on.** The reason is the phone: a call can ring at
  three in the morning with his desktop asleep, and transcription cannot be the thing that is off.
  **Conditional on the CPU-type change (§0)**; until then it runs the tiny model and **says it is
  degraded**. `[research]`
- **Speech out: the desktop voice server with the good voice** — starting at login, restarting on
  crash, loading on use, freeing the GPU when idle, reachable only by the lab server. **A backup voice
  on the lab server for when the desktop is off, which says that it is the backup.** `[ruling]`
- **The Home Assistant box cannot run speech at all** (no SSE4.2), which is what forces this layout.
  `[research]`

---

## 12. Cutoff

**Parker must be able to cut her off mid-sentence, on every channel.** A requirement, not a feature.
`[ruling]` [→ ticket](wayfinder/tickets/cutting-her-off.md)

**Nothing shipped does this.** `[research]`
[→ ticket](wayfinder/tickets/can-hass-carry-the-audio.md)

- Shipped satellites interrupt **by word only**: the wake word or "stop" halts playback on the device,
  does not start a new turn, and only arms about **one second into the reply**. ESPHome stops streaming
  the microphone at end of speech, so Home Assistant hears nothing while she talks.
- **Cancelling by starting a new pipeline cancels nothing audible.** The pipeline finishes once it
  hands out the TTS URL and the device plays it. There is no stop-playback method on the satellite
  entity. *An earlier draft of this spec claimed otherwise.*
- The stock **call** path cannot be cut off at all: it never transcribes audio arriving during a reply,
  clears it before the next turn, and its sender only exits on hangup.

**So:** on a call, our gateway carries the audio and cutoff is ours. In a room, real barge-in needs
**custom firmware on a satellite whose own chip cancels echo**, holding the microphone open through
playback. Home Assistant core and ESPHome have no echo cancellation; the official Voice Preview
Edition does it on its XMOS chip.

**The risk is acoustics, not Home Assistant, and this is the one thing that has already failed.** The
prototype shipped with echo cancellation and interruption switched off because measured safety gates
did not pass, and echo cancellation on open speakers was never proved. Her own voice returning through
the microphone looks like Parker cutting in, so the system interrupts itself. **A prototype on real
hardware is required per channel before the spec promises it**, measuring false cutoffs per minute of
her own speech and how long a real interruption takes to land.

**Do not assume a room speaker needs full barge-in.** Stop-by-word is shipped and may be enough there,
since private things never play on a room speaker. Ask Parker alongside the purchase. `[reasoning]`

---

## 13. When something is down

**Every failure fails closed on trust and loud on capability.** Nothing quietly becomes less private,
and nothing pretends to still work. `[reasoning]`
[→ ticket](wayfinder/tickets/when-something-is-down.md)

**Only the proofs that depend on the broken thing are lost.** A call proved by credential is checked by
the gateway, so Home Assistant being unreachable does **not** make that turn a guest turn — it loses
the device facts and the in-room rung and keeps the credential. One flaky integration must not demote
the only channel we can prove.

**Loud means once:** told once, in the turn where it matters, plus one alert to main. Named again only
when he asks for something it breaks. **Every degraded turn is logged even when nothing is said
aloud**, so restraint applies to speaking and never to recording.

Disclosure over silent degradation is `[research]` (Google PAIR on silent background errors;
Microsoft HAX; Kocielnik 2019, where setting expectations *raised* acceptance of a weak AI; Mahmood
2022 on apologies repairing trust). **"Once per outage" has no evidence and is `[reasoning]`.**
[→ ticket](wayfinder/tickets/failure-honesty-evidence.md)

**The journal is strict.** It is the only route work takes to main, so **if she cannot write a line she
says so and refuses the work** rather than accepting it and losing it. Never a cheerful yes that
evaporates.

**A head dying mid-sentence** is already safe, because every turn wrote its own line — but she **names
the gap** rather than carrying on as though nothing happened.

---

## 14. The phone line

### 14.1 Inbound: a stranger calls

**Day one is intake only.** No client tier and no booking rights: the phone research proposed them,
but Parker has never ruled that a client class exists and his client work is high-class data, so that
is a question to put to him rather than a capability to hand him pre-built. `[reasoning]`
[→ ticket](wayfinder/tickets/what-a-stranger-gets.md)

On a call from an unknown number, she:

- **Says in her opening line that she is an assistant answering for Parker, and that the call is being
  transcribed.** The FCC rule (24-17) only compels the disclosure outbound, but letting an inbound
  caller believe they reached a person is worse than the rule bothers to forbid. One party's consent is
  enough to record where he is, but callers can be anywhere and some states require every party's.
- **Takes a message**, promising it will reach him in **fixed, generic words** — never a time computed
  from his day.

  **How the message actually reaches him, since a digest cannot carry it.** `[reasoning]` The digest
  schema is fixed fields — who called, when, which intent from a fixed list, a callback number — and
  forbids free text, so it cannot carry "the replacement part arrives Thursday". But this section
  promises to pass the message on, and a spec that promises intake then discards the content is broken.

  So the message takes a **different route from the metadata**:

  - **The caller's words are stored as a transcript artifact** and delivered **to Parker**, who is a
    person reading a record rather than a context being fed.
  - **Main receives only the digest plus a reference to that artifact.** She never ingests the prose,
    so §10 holds unchanged.
  - **Main may not open the artifact on her own account.** If Parker asks her to act on it, that is him
    choosing to bring the content in, and it arrives as his instruction rather than the caller's.
- **Never answers free or busy live.** See §5.2.
- **Never** touches what his schedule says, where he is, who he is with, or anything about anyone
  else, and **never commits him** to anything.
- **Never transfers to his cell** unless he has set a rule saying so. A transfer is an action *on* him,
  not an answer *about* him.

**Two mechanisms, adopted as `[reasoning]`** rather than put to Parker, because they follow from
settled rulings rather than expressing a preference. Both were listed as open questions on the Nov 6
page.

- **The call-back.** An inbound call whose attestation is weak gets **called back** on his own number
  rather than trusted. What this buys is narrower than an earlier draft claimed: dialling his number
  defeats *caller-id spoofing*, because we choose the destination — but it **does not prove who
  answers**. So a called-back leg is subject to the same restriction as any outbound leg to him
  (§14.2): guest tier until proof under §3.3.
- **Nothing personal goes to voicemail**, and she establishes that a person rather than a machine
  answered before saying anything personal. It follows directly from "never on a room speaker", since a
  voicemail is a recording on someone else's system and strictly worse. The detection itself lives in
  the phone layer.

**Cost guard.** Every stranger call wakes the cheap model and the transcriber, so **cap calls and
minutes per unknown number per day**; past the cap, play a recorded message with **no model in the
loop**. A spam storm must not be able to make the house think or spend his money.

### 14.2 Outbound: Janet places a call

**The shape depends on who answers.** Parker: "depending on the recievers." `[ruling]`

- **Calling him** — **a fork originates the call, but the answering leg starts restricted.**
  `[reasoning]`

  **Dialling his number does not prove he answered.** Someone else can pick up, or voicemail can. An
  earlier draft had this branch hand a full-context fork straight to whoever answered, which
  contradicts the per-turn proof rule in §3 and would hand his context to an unproved stranger.

  So: the fork owns the task and the brief, and **the leg speaks at guest tier until proof under §3.3
  arrives.** In practice that means a call carried by his **signed-in app** can rise; a plain dialled
  leg has nothing that proves who is holding the phone, so it stays restricted for the whole call.
  Trust is re-checked every turn, as everywhere else.

  - **Voicemail, or any machine:** she leaves nothing personal. A fixed callback request only.
  - **An unknown answerer:** guest tier. She does not say why she called beyond what a stranger may
    hear, and does not confirm anything about him.
  - **No proof at all:** the restricted state *is* the resting state. It is not a failure mode.

  *This is the one place this spec interprets a ruling rather than applying it.* Parker said calls
  Janet places "are fork", and that is honoured — a fork originates and owns them. What he did not
  rule on is who is holding the phone at the other end, and the proof rule answers that.
- **Calling anyone else** — **guest-tier rules**, with a **digest** return path, because the far end is
  a stranger. **Flagged tension:** Oct 19 says "incoming calls will get a janet fork with
  limited context and tools", but **a fork cannot drop context** — which is why the Nov 6 page chose a
  fresh session instead. Ask Parker only if the spec comes to depend on it.

*Note on the record: "call outs" in his earlier ruling meant **voice commands**, not outbound calls.
This section was written once from the wrong reading and corrected.*

For the non-him case, **the brief must itself be schema-constrained — a digest going out.**
`[reasoning]`

This is forced by the Rule of Two, and it is worth spelling out because the obvious reading of "main
briefs it" breaks the rule. Such a session already holds two of the three: it hears **untrusted input**
(the person it called) and it **talks externally** (that is the whole point). So it may hold **no
sensitive data at all**. A free-text brief would smuggle sensitive data in as prose and quietly give it
all three.

Therefore the brief carries fixed fields only — the intent from a fixed list, and the minimum
parameters the task needs — mirroring the **digest** that comes back. Two useful consequences:

- If the person asks something about Parker that is not in the brief, the head **has nothing**, rather
  than having something and being trusted not to say it.
- The head **cannot improvise past the brief**, so it cannot commit him to anything he did not approve.

**Return path: a digest, never raw lines.** Same as the journal (§10).

**Placing the call needs his approval, and his voice is enough.** `[ruling]`

*Corrected: an earlier draft required a phone tap here, derived from a phone-tap rule for "the three"
that turned out not to be his (see §8). With that premise gone, this follows his actual ruling —
approval by voice on a private channel is sufficient.*

What survives, and is worth keeping on its own merits: **the brief is read back exactly as it will be
used, and logged.** `[reasoning]` A fixed-schema brief is only a meaningful thing to approve if he
hears the version that will actually be spoken. Calling *him* needs no approval at all: reaching him
is not acting as him.

**She discloses that she is an automated assistant calling for Parker.** Required outbound by FCC
24-17 for calls to mobiles, and done on every outbound call to anyone but him. `[research]`

---

## 15. Build order

1. **The desk on headphones, plus his phone.** Real cutoff on both, and **nothing to buy** — headphones
  have no echo path and a phone line gives a clean stream. `[reasoning]`
2. **The phone number.** Registration is the critical path and should be raised first even though the
  slice is second.
3. **The room**, which is the only place echo-cancelling hardware matters. A purchase, so it goes to
  Parker with a price.

**Rulings of Parker's have twice turned out to live only in a DM while a published page said the
opposite, and the page won by being easier to find.** The old voice plan pages are to be marked
superseded and pointed here, so the rulings live in one place.
