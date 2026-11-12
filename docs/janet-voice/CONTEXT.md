# Context: the Janet voice system

The vocabulary this effort uses, and the terms it has retired. A glossary only: what each word means,
never how it is built. Decisions live in [the map](wayfinder/map.md) and its tickets.

Scoped to `docs/janet-voice/`, because the repository has no root `CONTEXT.md` and these terms are
local to the voice system.

## The agents

**Main Janet.** The one long-running Janet, with her own memory, who does the real work. Everything
voice-facing exists to reach her or to stand in front of her.

- Say _main Janet_, not **Central** or **Janet Central**. The Nov 6 page called her Central; that
  name is retired to avoid implying a second entity.

**Head.** A voice-facing session a person is actually talking to. A head is defined by the **tier** it
serves, never by the device that reached it. There are exactly three kinds.

- A head is not the same thing as a **fork**. A fork is one way of making a head; not every head is
  one.
- Heads are separate processes because **a head cannot forget what it has already heard**. That single
  property is why the architecture has three of them rather than one with a label.

**His own head.** The head that serves a turn proved to be Parker. Holds his private context.

**Room head.** The head that serves a turn that is probably Parker but unproved, or a household
member. Holds public facts and the lamps. No private facts.

**Guest head.** The head that serves an unknown voice or unknown caller. Public facts only. No data,
no actions.

**Rung.** How much machinery a _request_ needs, on Parker's ladder: **0** Home Assistant's own intent
matcher with no model, **1** a cheap limited session, **2** a **fork** of main, **3** main Janet. Chosen
by the kind of thing being asked, and re-chosen fresh on every turn. Independent of **tier**.

- A head is a **rung and a tier**. Neither determines the other.
- Parker says **callout** and means a voice command — a rung-1 request. It does **not** mean an
  outbound call; reading it that way cost this effort two wrong drafts.

**Brief.** The fixed-schema instruction given to a session placing a call on Parker's behalf to
someone who is not him — intent and minimum parameters, never free text. A **digest** travelling
outward. It is read back to him exactly as it will be used, and logged, so that what he approved is
what happens.

**Fork.** A child session started from main Janet's own context, so that it is continuous with her
rather than merely informed about her.

**Quarantined model.** A model with no tools, whose only job is to read untrusted words and emit a
**digest**. It exists so that main Janet never reads untrusted words herself.

**Spare.** _Retired 2026-11-11._ A head prepared before anyone is talking. Parker ruled four seconds
on the first turn acceptable, so no head is kept warm and the term is gone. Heads **spawn on the first
turn**.

## Trust

**Tier.** How much is proved about who is speaking and where. The tier selects the head. Re-judged on
**every turn**, against the channel that turn arrived on, and never inherited from the conversation.

**Proof.** Evidence present _on this turn_ that establishes the tier. A credential or a signed-in app
proves; a caller id does not, because it can be spoofed.

**Rise.** A turn moving to a higher tier. Needs proof on that turn, never a claim.

**Drop.** A turn moving to a lower tier.

- A drop carries only the words the speaker said. A rise carries only a **digest**. Neither carries
  raw context across the boundary, in either direction.

**Envelope.** The facts travelling with a turn — which device, which channel, how Parker was reached.
Facts, never instructions, and never guesses.

## Data

**Data class.** What a fact is, independent of who is asking: **public**, **low** (personal but not
secret), **high**, **secret**. An untagged fact counts as high, so a missing tag fails closed.

**Secret.** Never enters any head, at any tier.

**Aggregate class.** The class of a fact _answered repeatedly on demand_, which can exceed the class of
the fact itself. Free/busy is public once and an **oracle** asked twice.

**Oracle.** A head that can be interrogated to reveal something no single answer discloses.

**The three.** Money, sending anything as Parker, and deletions. Named because earlier drafts gave
them a special rule; **they do not have one.** His Oct 28 ruling admits no carve-out, so a voice
approval on a private channel covers them like anything else. Kept as a term only because a standing
recommendation concerns them.

**Phone tap.** A confirmation given by touching his phone. **Not required anywhere in this spec** — it
appears only in the standing recommendation about money, where a demonstrated voice-clone attack
contradicts the premise his ruling rests on.

## Memory

**Journal line.** What one turn appends about itself, as part of that turn. Carries the words, the
tier, the speaker or _unknown_, and what the head did. A conversation never announces that it is over,
so nothing waits for the end.

- A line's tier comes from the **proof on the turn**, not from which head made the sound. Only the
  head that owned the turn writes a line.

**Digest.** A fixed-schema summary — set fields, never free text — produced by a **quarantined
model**. The only form in which untrusted words reach main Janet.

**Taint.** The property that a context takes the worst label in its history and never loses it. Why
untrusted words are digested rather than quoted: quoting marks a line without disarming it.

## The way in

**Front door.** Home Assistant, which decides and routes every voice turn, on every channel.

**Satellite.** A device that listens and speaks in a room, registered with the front door.

**Phone layer.** What sits beneath the front door and supplies what Home Assistant has none of:
transfers, keypad digits, voicemail detection, dialling out, trunk registration.

**Cutoff.** Parker interrupting Janet mid-sentence and being obeyed. A requirement on every channel,
not a feature.

**Warm** and **cold.** Whether a head's first turn has already been paid for. Warm is about cost;
having already spent the first turn is about speed. They are different levers and are not
interchangeable.

## Retired

Say these only to explain what replaced them.

- **Patrice** — an earlier separate assistant persona. There is one Janet.
- **Mini Janet** / **janet-mini** — the prototype this system replaces.
- **Fast Janet** — a small brain with its own _identity_. There is no separate Janet. The **command
  rung is a rung, not a persona, and the cheap model is something a head _runs_.
- **Janet Central** / **Central** — see _main Janet_.
- **Spare** — see above. Spawn-on-first-turn replaced it.
- **Quiet hours** — ruled out on 2026-10-27. Decisions key on who is asking and who is present, never
  the clock.
