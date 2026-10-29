# humanize-doc — worked before/after examples

The job is fidelity _and_ readability. Watch how the good rewrites keep every technical term while making the mechanism legible.

---

## Example 1 — latency under load

**Dense source**

> The model exhibits elevated latency under high-concurrency inference workloads due to KV-cache pressure and scheduler contention.

**❌ Too dumbed-down (precision lost)**

> The system can get slow when lots of people use it because the AI gets overwhelmed.

_Why it fails:_ "gets overwhelmed" invents a vague cause and drops KV-cache, concurrency, and scheduler contention — the actual claims.

**✅ Humanized (precision kept)**

> When many requests arrive at once, the model slows down, for two reasons. First, KV-cache pressure: the KV cache, a memory store the model uses while generating text, comes under pressure. Second, scheduler contention: requests compete for the scheduler, the part that decides which request is processed next.

_Why it works:_ latency, concurrency, KV-cache pressure, and scheduler contention all survive, and both stay causes; the new terms are defined in place; nothing is added about what is _not_ the cause; given-new flow ("When many requests arrive…" is the familiar setup; the two causes are the new point).

---

## Example 2 — preserving a caveat

**Dense source**

> Preliminary benchmarks suggest the warm-cache path _may_ reduce cold-start cost by ~40%, though results were not validated across model sizes.

**❌ False confidence**

> The warm-cache path cuts startup cost by 40%.

_Why it fails:_ deletes "preliminary", "may", "~", and the "not validated across model sizes" caveat — turns a hedge into a hard claim.

**✅ Humanized**

> Early benchmarks hint that the warm-cache path may cut cold-start cost by roughly 40%. Treat that as a first read, not a guarantee: it hasn't been tested across different model sizes yet.

_Why it works:_ keeps the uncertainty markers and the scope limit, in plain words.

---

## Example 3 — leading with the point (Minto / Andy-Weir)

**Dense source**

> The consolidation routine is invoked by the scheduler when the context window utilization crosses a configurable threshold, at which point a subagent is forked to summarize and persist long-term memories.

**✅ Humanized**

> The agent consolidates its memory on a trigger. The scheduler watches how full the context window (the agent's working memory) is. Once that crosses a configurable threshold, the scheduler invokes the consolidation routine, which forks a subagent, a helper split off from the main agent, to summarize and persist long-term memories.

_Why it works:_ leads with the point (consolidation is triggered), then unpacks the mechanism in the source's order; "configurable" survives; "forked subagent" is defined in place; one idea per sentence; nothing invented: the source says what the subagent is forked to do, not that it does nothing else, so the rewrite doesn't say "only".

---

## Glossary emission (what to append)

From the rewrites above, the glossary block would be:

```markdown
## Glossary

- **KV cache** — a memory store the model uses while generating text; it comes under pressure under high concurrency.
- **scheduler contention** — requests competing for the scheduler, which decides which request is processed next.
- **warm-cache path** — reusing an existing cache so a process starts "warm" instead of cold.
- **forked subagent** — a helper agent split off from the main one.
```
