---
name: researching-with-vault
description: "Researches a question against the lab vault: checks what the vault already holds, fetches only the gaps, captures every cited source, gives each claim a verdict, and writes the result as a vault tree rooted at a run note. Use for any research, prior-art, teardown, comparison, or 'is this right?' question, before recommending a design or a default, and whenever a result should be reusable by other agents."
---

# Researching with the vault

The vault is the lab's shared knowledge store. It holds **claims** (one checkable statement each, with a permanent ID like `c-7f3k2abc`), **sources** (saved artifacts and lab documents, with quoted passages), **topics** (the notes claims live in) and **runs** (one per research run). Every claim links to its evidence with a typed link. The Obsidian vault people browse is generated from it.

Research always runs. Do not ask whether to research, and do not ask which sources to use. What is conditional is fetching: fetch only what the vault does not already hold in good condition.

## Who does the research

Research runs in a subagent, so raw pages never fill the coordinating agent's context. If you are coordinating, spawn the `vault-researcher` agent with the question and any constraints, and keep only the run note it returns. If you are the researcher, do the steps below yourself.

## The run, step by step

### 1. Frame the question

Write down, before searching:

- the question in one sentence, and the decision it feeds;
- the options or sub-questions it breaks into;
- what evidence would settle each one.

For "how should we build X" questions, the first sub-question is always what already exists: prior art, open-source clones, teardowns and published internals. Cover the field broadly before going deep on one candidate.

### 2. Check the vault first

```sh
vault research-check "<the question>"
vault recall --passages "<each sub-question or key term>"
```

`research-check` returns matching claims, matching passages from saved sources and migrated lab research, and a `recheck` list. Read the hits. Earlier lab research lives in the vault as sources with `kind` `research`, `memory`, `gallery` or `context`; cite those passages instead of redoing the work.

Sort every sub-question into one of three piles:

- **Answered and fresh.** A claim with a fresh source covers it. Reuse the claim by ID.
- **Answered but on the `recheck` list.** The source is past its shelf life, replaced or retracted. Look for something newer for these only. If a newer version exists, capture it and replace the source (step 4).
- **Gap.** Nothing in the vault covers it. These are the only things to search the web for.

### 3. Fill the gaps under the source bar

A source clears the bar when it is a primary source (a paper, official documentation, an official engineering post, source code at a commit) or a careful practitioner writing from direct experience. Listicles, SEO explainers, vendor marketing pages and hype threads do not clear it. Prefer three excellent sources to ten adequate ones, and read each source you cite; an abstract is not the paper.

Capture every source you will cite before you cite it:

```sh
vault source add "<url | DOI | arXiv ID>"
```

This saves the artifact through vault-cite and prints its `src-…` ID. A source already saved is reused without a fetch. If the capture fails, the reference goes in the run's `gaps` with the reason, and no claim may rest on it alone.

### 4. Write claims with verdicts

One claim is one line stating one checkable thing, with its numbers and its conditions. Give each claim:

- a **verdict**: `supported` (the evidence agrees), `mixed` (it holds only under stated conditions, or sources disagree), `contradicted` (the evidence says otherwise; state the claim as the thing that was tested), or `new` (no prior evidence exists; say so, and propose the smallest experiment with a success bar and a drop condition);
- a **source type**: `PRIMARY` (rests on a saved artifact), `DIRECT` (someone said it or you observed it; name who and when), `DERIVED` (your inference from other claims or from lab write-ups), `GUESS` (no evidence; allowed, but labelled);
- **links** to the passages that back it: `supports`, `contradicts`, or `source` for where a statement comes from. Quote the passage from the source; the quote is what a later reader checks the claim against.

Before settling on an answer, write the strongest case for the option you are about to reject, as its best advocate would. Record what survives of it as claims. State what you looked for and could not find; an absent result is a finding.

When a source on the `recheck` list has a newer version:

```sh
vault source replace <old-src-id> <new-src-id> --reason "<what changed>"
```

Every claim citing the old source is flagged stale. For each flagged claim that matters to this question, either replace it with a corrected claim (`replaces` in the run input) or leave it flagged and list it under stale.

Claims are never edited. To correct one, write a new claim that `replaces` it.

### 5. Write the run tree

Put the whole run in one JSON document and write it:

```sh
vault research-run run.json
```

```json
{
	"question": "How big should one vault note be for agents?",
	"summary": "Two or three sentences: the answer, the main caveat, and how confident you are.",
	"topics": [
		{
			"title": "Note granularity for agent vaults",
			"summary": "How big a vault note should be when agents read and write it.",
			"hub": "Agent memory",
			"shelfLifeDays": 365
		}
	],
	"passages": [
		{
			"key": "densex-t3",
			"source": "src-0123456789abcdef0123",
			"text": "Table 3: proposition indexing, Recall@5 +12.0 (SimCSE), +9.3 (Contriever)."
		}
	],
	"claims": [
		{
			"key": "units",
			"topic": "Note granularity for agent vaults",
			"heading": "Retrieval unit",
			"text": "Indexing propositions beats indexing passages for unsupervised retrievers (Recall@5 +9 to +12).",
			"verdict": "supported",
			"sourceType": "PRIMARY",
			"links": [{ "rel": "supports", "to": "densex-t3" }]
		}
	],
	"reused": ["c-7f3k2abc", "src-fedcba98765432100123"],
	"answer": ["units"],
	"gaps": [{ "ref": "https://example.org/paywalled-study", "reason": "subscription required" }]
}
```

`key` names a passage or claim inside this document, so links can point at things that have no ID yet. A link's `to` is a passage key, a claim key, a source ID or an existing claim ID. `topics[].shelfLifeDays` is how long sources stay fresh for this topic: short for fast-moving subjects such as model capabilities or pricing, long for settled ones. `reused` lists existing claims and sources the answer relies on unchanged.

The command prints the **run note**. It lists what the run created, updated, reused and found stale, and links to each; it never restates a claim.

### 6. Return the run note

Your reply to whoever asked is the run note, plus one paragraph: the recommendation, the strongest objection to it, and what you could not find. Give a clear recommendation even when the evidence is mixed.

If a person will read the result, the coordinating agent turns the run into a page for them; the run note is written for agents.

## Rules of the vault

- Write only through `vault` commands or the vault MCP tools. The markdown files are generated and are overwritten on the next projection.
- A claim that is not a `GUESS` needs a link to a source in the vault. A URL is not a source until it is captured.
- Nothing secret goes in: the engine rejects any write that carries a credential. Remove the credential; do not rephrase around the scan.
- Cite claims by ID in later work, so the next run can find what depends on them.
