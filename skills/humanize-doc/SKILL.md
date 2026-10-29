---
name: humanize-doc
description: Rewrite a dense technical, research, or design document into clear, engaging plain English for a smart non-specialist — preserving every factual claim, number, caveat, and technical distinction — and emit a glossary of the jargon. Use when a doc is long or jargon-heavy and someone wants the "human version" (e.g. the plain-english toggle in the tasks reader). Andy-Weir explanatory voice: concrete, momentum, jargon-defined-in-place, never dumbed-down.
---

# humanize-doc

Turn a wall of dense technical prose into something a smart, busy non-specialist reads top-to-bottom without stalling — **without losing a single fact**. This is a controlled transformation: preserve the claim graph, change the reader experience. You are not "making it sound human"; you are managing four things separately — factual content, structure, explanation, and prose texture.

Grounded in Gopen & Swan (_The Science of Scientific Writing_), Minto's Pyramid Principle, plain-language principles, and PLOS "Ten Simple Rules for Science Writing." Full research: `/home/docker/.claude/shared/research-agent-writing/agent-writing.clean.md`.

## Use when

A doc is long (>~1500 words) or jargon-heavy and a reader wants the gist fast: research syntheses, architecture notes, incident reports, design specs, API docs, policy text, agent teardowns. In the tasks app this fills `body_alt` (the plain-english toggle) and appends a `## Glossary` the reader turns into hover-definitions.

## Non-negotiables (fidelity first)

- **Preserve every fact**: claims, numbers, constraints, causal links, and uncertainty markers ("may", "observed", "estimated", "under these conditions") survive verbatim in meaning.
- **Invent nothing**: no examples, benefits, mechanisms, citations, or motivations that aren't in the source. An illustrative example must be _labeled_ as illustrative.
- **Keep precision**: keep a technical term when replacing it would blur meaning ("scheduler contention" ≠ "busy servers"). Define it in place instead.
- **Mark gaps, don't fill them**: if the source skips a logical bridge, flag it — never paper over it with a plausible guess.
- **No flattery, no hype**: clarity over cleverness. Don't praise the source or the reader.

## The voice (Andy Weir explanatory)

Weir makes hard science gripping by being _concrete and honest_, not flowery. Steal these moves:

- **Lead with the stakes or the punchline**, then unpack. ("The bottleneck isn't compute. It's memory.")
- **One idea per sentence, forward momentum.** Each sentence earns the next. Short sentences land consequences.
- **Define jargon the instant it appears**, inline, in plain words — then keep using the real term so precision survives.
- **Concrete over abstract**: a number, a mechanism, a "here's what actually happens" beats an adjective. But only concretize what the source supports.
- **Dry, confident, a little wry** — never salesy, never breathless, never "delve into the fascinating world of."

## Workflow (run in passes — don't one-shot it)

1. **Source map.** List every claim, number, definition, causal statement, caveat, and named entity. This is your fidelity contract.
2. **Reader model.** Assume a smart layperson: capable, busy, not domain-trained. Define only terms that _block_ understanding.
3. **Structure.** Minto for summaries/memos (answer first, then grouped support); chronological/procedural order for tutorials. Each paragraph answers one reader question and stays "about" one subject.
4. **Explain.** For each hard concept use exactly one of: definition-in-place, concrete example, labeled analogy, contrast with a familiar thing, or "why it matters." Given-new flow: open each sentence with the familiar, end with the new/emphasized point (Gopen & Swan topic/stress positions).
5. **Prose pass.** Active voice where agency matters; subject and verb close; vary sentence length (don't write five same-length sentences in a row); cut throat-clearing and generic transitions.
6. **Fidelity check.** Compare output to the source map claim by claim. Flag any omitted caveat, softened constraint, invented benefit, changed quantity, or unsupported causal link. Fix or flag.

## Ban list (AI-slop tells — cut on sight)

delve, unlock, seamless, robust, game-changing, ever-evolving landscape, testament to, "it's not just X, it's Y", "in today's world", "dive into", "navigate the complexities", em-dash-pile-ups used as suspense, and any decorative metaphor that doesn't explain a mechanism.

## Output format

Return markdown with two parts:

```markdown
<the rewritten human version — clean prose, headings allowed, no meta commentary>

## Glossary

- **Term** — one-sentence plain definition (the reader shows these on hover).
- **Another term** — definition.
```

Pull glossary terms from the jargon you defined in place: acronyms, internal flag/system names, domain terms a layperson wouldn't know. Definitions must be faithful to the source. Longest/most-specific terms are fine; the reader wraps the first occurrence of each.

Then, separately (not in the document body), report **fidelity notes**: what you preserved, anything you omitted on purpose, and any source gaps or ambiguities the author should resolve.

## Self-score before returning (1–5 each)

fidelity · clarity · precision · structure · flow · concreteness · tone · rhythm · jargon-handling · guardrail-behavior.
**Hard floor: fidelity, precision, and guardrail-behavior must each be ≥4.** A rewrite that reads beautifully but scores <4 on fidelity has failed — redo it.

See `rubric.md` for the full scoring guide and `examples/before-after.md` for worked rewrites.
