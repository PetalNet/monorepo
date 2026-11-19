# fold-cards

The recall index behind Janet's claude-fold mods. It turns finished stretches of Claude Code transcripts into snippet cards, mirrors directories of Markdown notes and documents beside them, and answers a prompt with the few items likely to help, usually none. It needs `python3` with SQLite FTS5. The optional local embedder needs `bin/embed-setup`.

```sh
bin/cards.py build  --db DB --session ID [--transcript PATH] [--ledger-cards FILE]
bin/cards.py query  --db DB --text TEXT [--k 4] [--exclude PTR,PTR] [--sources fold,memory] [--thread JSON]
bin/unfold POINTER [--db DB] [--max-tool-chars N]
```

A card is one finished stretch: a person's prompt and everything up to the next prompt. Its pointer is `<session>:<uuid of the prompt row>`; `event:<channel event_id>` also resolves. `build` is idempotent: it resumes from the byte offset it stopped at. `unfold` prints the exact transcript passage behind a pointer.

The compaction mod (`fold`) runs `build` before each compaction, and the recall mod (`fold-recall`) runs `query` on every prompt. Those mods live in Janet's private config repo and call `bin/cards.py` by path.

## How recall ranks

Recall attaches nothing unless something is likely to help. On 59 real prompts graded by hand, the old top-4 recall attached about 4 items to every prompt, and 66% of prompts got only unhelpful ones.

Cards, memory notes and documents are sources in one index, `bin/memindex.py`. Each directory under `index.notes` in the fold `<state>/config.json` is mirrored as whole notes on every `cards.py build`; each directory under `index.docs` is mirrored as heading-led chunks (only `*.md`, at most 100 KB a file, no `result.md` or `*.log.md`, and no chunk that looks like a credential). For each prompt:

1. **Clean.** The query is what the person wrote. The `<channel>` tag, the untrusted-content trailer, the `[!room - name] [sender]:` prefix and media lines are stripped. Ranked as-is, those words outvoted a short message: "Status?" pulled four cards about channel routing. A harness notice, such as a task notification, is not searched at all.
2. **Candidates.** For each source, take the top 60 by cosine from a local embedding model, `BAAI/bge-small-en-v1.5` (quantized ONNX, 65 MB, CPU only), and the top 60 by BM25 over FTS5. A message under 6 content words leans its dense query toward the last 2 turns of its room within the hour, so "and the other one?" means what the thread was about. `bin/embedder.py` keeps the model and every vector in memory, serves searches on `<state>/embed.sock`, and embeds new documents every 20 seconds. A note is embedded as its name, description and body, not its frontmatter.
3. **Gate.** Two logistic stages. Stage one is a model per source over the 20 closest candidates. Its inputs are the cosine, how far the candidate stands above its own query's top 20 (z), whether a rare query term matched (`MIN_IDF`), rank, and message length. A generic message pulls generically high cosines, so the gate uses relative standing, not absolute cosine. A candidate with stage-one p below 0.25 is dropped. Stage two rescores the rest from the stage-one logit, the candidate's place in BM25 order (a keyword match far down the list scores low, so "amp" on an Amp-skills message no longer pulls the amp-runner note) and the message length (a long pasted message matches everything a little). Candidates attach at stage-two p >= 0.35, at most 2 per source and 3 in all. Documents have no model yet: only 7 of 1,310 graded candidates were helpful documents, and none could be picked precisely, so they are indexed and never attached.

Without the embedder nothing attaches; the first query starts it for the next prompt. `MEMORY.md`, which Claude Code already loads, is never attached. Install the embedder with `bin/embed-setup`.

`python3 -I test/eval_recall.py --fixture FIXTURE [--latency]` scores the live index on a graded fixture: 59 real prompts with their room threads, and 1,310 candidates graded blind (2 helps, 1 related, 0 unrelated) from a pool of the old recall, BM25 and the embedder. Each prompt only sees what existed when it arrived. The eval compares the gate with the old recall and three broken variants, and fails if any broken variant scores as well as the gate, or if `cards.py query` takes over 300 ms at p95.

|                              | precision | recall | prompts with nothing attached | prompts with only unhelpful items | tokens per prompt |
| :--------------------------- | --------: | -----: | ----------------------------: | --------------------------------: | ----------------: |
| old recall                   |      0.12 |   0.32 |                            3% |                               66% |         about 760 |
| gate, 2-fold cross-validated |      0.62 |   0.18 |                           75% |                                5% |          about 65 |

A second fixture grades what the gate attached, not what the ranker found: 543 real (prompt, attachment) pairs from one week, 129 of them attached live, each judged by reading the prompt and the attached note or card. Stage one alone attached 413 of them at precision 0.385. Stage two attaches half as many and keeps 72% of the helpful ones. Refitting its three weights on 60% of the prompts and measuring the other 40%, averaged over 200 splits, gives precision 0.48 (sd 0.08 between splits) against 0.39 for stage one, recall over the sampled candidates 0.39 against 0.47, and 70% of stage one's helpful attachments kept. `test/fit_attach.py` reproduces those numbers and refits the weights. Both fixtures are real conversation, so they are kept private, beside the deployment's config, and not in this repository.

## Tests

```sh
python3 -I test/test_cards.py
python3 -I test/test_memindex.py
python3 -I test/test_recall.py
python3 -I test/fit_attach.py --fixture FIXTURE [--fit]   # the private recall_attach.json
```
