---
title: What a stranger gets on the phone
label: wayfinder:grilling
status: closed
resolved: 2026-11-11
---

## Question

The number is in scope, so an unknown caller is a real case, not fog. The guest head already answers
what it _knows_ (public class only, untrusted speech, attributed facts only). This ticket is what it
_does_.

From the phone research: callers were to be scoped by class, with an unknown caller getting intake
plus free/busy, a client getting booking, and Parker or a VIP getting a transfer. None of that is
ruled yet. Also unruled: what Janet may do on a call with someone who is not Parker, whether she may
take a message, how a message reaches him, and whether she says she is an assistant.

One external constraint is not ours to choose: FCC 24-17 means an AI voice calling a mobile needs
consent, so an outbound automated call must disclose itself. For recording, one party's consent is
enough where he is, but a caller may be somewhere that requires every party's. These bound the answer
rather than being decided by it.

## Resolution

Day one is **intake only**. No client tier and no booking rights: the phone research proposed them,
but Parker has never ruled that a client class exists and his client work is high-class data, so that is a
question to put to him rather than a capability to hand him pre-built.

What she does on a call from an unknown number:

- **Says, in her opening line, that she is an assistant answering for Parker, and that the call is
  being transcribed.** The FCC rule only compels the disclosure outbound, but letting an inbound
  caller believe they reached a person is worse than the rule bothers to forbid. recording consent is one-party where he is, but callers can be anywhere and some states require every party to consent, so
  one clause up front costs nothing and removes the question.
- **Takes a message**, and promises it will reach him in **fixed, generic words** — never a time
  computed from his day.
- **Never answers free or busy live.** A stranger gets "he isn't taking calls right now, I'll make
  sure he gets your message", every time, whatever his calendar actually says.
- **Never** touches what his schedule says, where he is, who he is with, or anything about anyone
  else, and **never commits him** to anything.
- **No transfer to his cell** unless he has set a rule saying so. A transfer is an action _on_ him,
  not an answer _about_ him.
- **The message reaches him as a stored transcript artifact**, and **main receives only the digest
  plus a reference to it**. _(Corrected 2026-11-11: this first said "quoted as external data", which
  both predates the digest rule and cannot carry an arbitrary message anyway. A digest is fixed fields;
  a message is prose. They need separate routes, or the intake promises something it then throws
  away.)_ Parker reads the artifact as a person. **Main never ingests it, whoever authorises the work** —
  authorisation is not provenance, so his asking her to handle it does not make the caller's words his.
  Either he gives his own instruction, or the quarantined model returns permitted structured fields.

### Why free/busy is withheld even though it is public class

Janet's catch, and it is the sharp one. Free/busy is public class **as a fact on a page**, but answered
**on demand, repeatedly, to anyone who dials**, it turns her into a presence oracle. A caller who
dials at 10:58 and again at 11:05 learns when he is reliably unavailable, and a reliable daily pattern
approximates location, which his privacy bar is hardest on.

**This generalises past the phone, and is recorded as a spec-wide rule:** a public-class fact answered
on demand can leak a private one through repetition. Classifying each fact on its own is not
sufficient; the aggregate has to be classified too.

**Its boundary, from Janet:** the rule applies to **every head below the rung that unlocks the fact**,
not to every non-private head. Once Parker's ceiling decision says voice match unlocks his schedule on
a room speaker, a matched voice gets computed answers inside that band, and the fixed script covers the
unmatched voice and the guest. Without that boundary the rule would read as banning him from asking
what is next while he is on the sofa, which is not what it is for.

### Cost guard

Every stranger call wakes the cheap model and the transcriber, so a robocaller or someone redialling
in a loop spends Parker's money. **Cap calls and minutes per unknown number per day; past the cap,
play a recorded message with no model in the loop.** This also serves his zero-idle rule: a spam storm
must not be able to make the house think.

Closed with Janet as manager, 2026-11-11, with her three changes folded in.
