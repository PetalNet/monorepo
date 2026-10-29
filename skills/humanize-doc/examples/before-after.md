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

> When many requests arrive at once, the model slows down. The bottleneck isn't raw compute. The system also has to manage the model's KV cache — a memory store it uses while generating text — and decide which requests get processed next. Under heavy load, those two jobs fight for the same resources.

_Why it works:_ latency, concurrency, KV cache, and scheduler contention all survive; the new term (KV cache) is defined in place; given-new flow ("When many requests arrive…" is the familiar setup; the bottleneck is the new point).

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

> When the agent's working memory fills up, it doesn't just start forgetting. A scheduler watches how full the context window is, and once it crosses a set threshold, it spins off a helper — a forked subagent — whose only job is to summarize what mattered and file it into long-term memory.

_Why it works:_ leads with the stakes ("doesn't just start forgetting"), then unpacks mechanism in order; "forked subagent" defined by its job; one idea per sentence; nothing invented.

---

## Glossary emission (what to append)

From the rewrites above, the glossary block would be:

```markdown
## Glossary

- **KV cache** — a memory store the model uses while generating text; managing it adds overhead under load.
- **scheduler contention** — the system competing with itself over which requests to process next.
- **warm-cache path** — reusing an existing cache so a process starts "warm" instead of cold.
- **forked subagent** — a helper agent split off from the main one, inheriting its context.
```
