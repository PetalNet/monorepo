# Vault engine

`@petalnet/vault-engine` is the lab's knowledge store for agents. Loro CRDT documents are the
source of truth; the Obsidian vault is a generated projection, and the claim index is a read
replica. [`@petalnet/vault-cite`](../vault-cite) is the evidence layer underneath: it saves the
artifacts that claims cite.

## Model

- A **claim** is one checkable statement on one line, with a generated permanent ID (`c-` plus
  eight characters). Claims are immutable: correcting one adds a new claim that `replaces` it, and
  the old one stays, marked superseded.
- A **source** is a saved vault-cite artifact (`capture`), a record of who said or observed
  something (`direct`), or a lab document copied in verbatim (`research`, `memory`, `gallery`,
  `context`). Sources carry **passages**, each with an ID a claim can point at.
- A **topic** is the note claims live in. A **run** is one research run: the root of the tree of
  claims and sources that run created, updated, reused or found stale.
- Claims link to evidence with typed links: `source`, `supports`, `contradicts`, `replaces`. Every
  claim carries a source type: `PRIMARY`, `DIRECT`, `DERIVED` or `GUESS`. Only a `GUESS` may have
  no source.

Every record is an Effect Schema (`src/schema.ts`). Each sensitivity tier (`shared`, `personal`,
`agent`) is its own Loro document at `<root>/docs/<tier>.loro`, so one tier's history is never
inside another tier's file. A `shared` record cannot link into another tier, and a source ID lives
in one tier only.

Inside a document every map holds plain values keyed by ID. Anything two replicas may write at the
same time has its own key: a claim's text (`claims`), its retirement (`retired`), its stale flag
(`stale`), a source's record (`sources`), its status (`sourceStatus`) and each passage
(`passages`, keyed `<source>#<passage>`). A quoted passage's ID is a hash of its text.

## Write path

`Vault.transact(tier, message, body)` runs one write under the vault's write lock (one lock for all tiers, since a write checks the others). The body gets a `Tx`
whose methods are the only operations there are: add, replace or retract a claim; put a source,
topic or run; add a passage; retire a source; flag dependents. The Loro document stays inside the
service. Each operation checks its record strictly against its schema before writing it. A source
is checked whole, with all its passages, before any part is written, and a passage never changes
once written.

At commit, everything the write added to the op log, commit message included, passes the secret
scan (`src/secrets.ts`, following the gitleaks rules); a hit refuses the whole write and names only
the rule. The commit also confirms that every claim that existed is still there with the same core,
that a retired claim stays exactly as it was retired, and that every ID a record in the tier holds
(links, replacements, citations, hubs, run lists) names a record in that tier or in `shared`. The snapshot is written to a temporary file, synced, and renamed
over the tier file only if that file still holds the bytes the write started from. The replaced
version stays beside it as `<tier>.loro.prev`.

Each agent on each host writes as its own Loro peer, and each write is one change with a timestamp
and a message. `vault history <tier>` prints that log; `vault at <tier> <time>` prints the tier as
it stood then.

Replacing or retracting a source flags every active claim that cites it, in every tier, and a claim
written later against a retired source is flagged when it is written. `vault reconcile` finishes a
retirement that was interrupted between tiers.

## Read path

`vault reindex` rebuilds `<root>/index.sqlite` and swaps it in with one rename. Each claim is
indexed with its topic title and heading as retrieval context, and stored with its sources and
their freshness. A source is `fresh` until it is older than its shelf life (the source's own, else
the topic's, else 365 days); `replaced` and `retracted` override age. Recall reads only this file,
as does any other reader such as a per-prompt recall hook.

`vault project [dir]` regenerates the Obsidian vault:

```text
Index.md
<tier>/Topics/<title>.md          claims as list items under headings
<tier>/Sources/<kind>/<id>.md     passages, then a generated Dependents list
<tier>/Runs/<run-id>.md           the run tree root; links and embeds, never restates
<tier>/Claims/<claim-id>.md       a claim that three or more other topics link to
```

A claim line looks like this:

```markdown
- Proposition indexing beats passage indexing. [supports:: [[src-0123456789abcdef0123#^p1|Dense X Retrieval]]] [basis:: PRIMARY] [verdict:: supported] ^c-7f3k2abc
```

Agent-supplied text is written literally: brackets, `::`, `<` and `%%` are escaped. A copied
passage stays markdown with `<` and `%%` escaped outside code, and a fence it leaves open is closed
after it.

The projection owns `Index.md`, `.vault-projection.json` and one folder per tier. It writes the new
tree into a fresh folder it creates, then renames each owned entry into place, so a write or
removal never follows a link out of the folder, and everything else there (`.obsidian/`, your own
notes) is left alone. Notes are read-only; a hand edit is reported and replaced on the next run.
`vault lint [dir]` checks from the files that every claim ID appears exactly once, that every
passage is a visible block, and that every generated link resolves to a note and block.

## Agent surface

`src/api.ts` declares the agent operations with `@petalnet/effect-api`: `recall`, `remember`,
`research_check`, `research_run`, `source_add`, `source_retire` and `claim_retract`. `vault serve`
serves them over MCP (Streamable HTTP at `/mcp`, bound to `127.0.0.1:7411` by default). The CLI
runs the same operations, decoding its flags with each operation's input schema.

| Command                                                                     | Behavior                                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `recall <query> [--k N] [--passages] [--json]`                              | Claims matching the query, each with its sources and freshness.                    |
| `remember --topic T [--source REF] [--direct W --quote Q] <text>`           | Store one sourced claim; an unsaved reference is captured first.                   |
| `research-check <question>`                                                 | What the vault holds on a question, and which sources to re-check.                 |
| `research-run [file]`                                                       | Write a research run tree from JSON (a file or stdin); prints the run note.        |
| `source add\|replace\|retract`                                              | Capture a source through vault-cite; replace or retract one, flagging its claims.  |
| `claim retract <id> --reason R`                                             | Retract a claim. Its ID stays.                                                     |
| `reconcile`                                                                 | Flag claims whose sources were retired.                                            |
| `project [dir]`, `lint [dir]`, `reindex`                                    | Regenerate and check the read side.                                                |
| `history <tier>`, `at <tier> <time>`, `status`                              | The op log, time travel and counts.                                                |
| `index`, `snapshot <tier>`                                                  | The claim index, or a tier's Loro snapshot, on stdout.                             |
| `migrate <manifest.jsonl> [--deny file] [--deny-passing N] [--report file]` | Copy documents and vault-cite sources in; report exclusions and unsaved citations. |
| `serve [--host H] [--port P]`                                               | Serve the agent operations over MCP.                                               |

Run `pnpm --filter @petalnet/vault-engine vault <command>`, or `node src/cli.ts`. Environment:

- `VAULT_ROOT`: where the vault lives on this host (default `~/.local/share/vault`).
- `VAULT_AGENT`: the writing agent's name.
- `VAULT_CITE`: the vault-cite CLI as a command line, for example
  `node /checkout/packages/vault-cite/src/cli.ts`, or the same behind `ssh`.
- `VAULT_PROJECTION`: an Obsidian folder kept current after each write.

## Hosts

One host holds the vault and runs every write. `scripts/vault.sh` is the CLI with that host's
settings, and `vault.sh serve` is the MCP server agents on that host connect to. Other hosts use
`scripts/client.sh`, which runs each command there over ssh and, after a command that writes,
copies the claim index back, so local readers never need the network. `client.sh tunnel` forwards
the MCP port and keeps the index copy fresh while it runs. `vault serve` has no credentials: it
binds loopback, serves only a loopback `Host` and refuses any request carrying an `Origin` (so a web
page cannot reach it by DNS rebinding), and every write over MCP is attributed to the server's
`VAULT_AGENT`. Any local process on a host that runs it or its tunnel can write. `scripts/deploy.sh` installs a release
from `main` into its own directory and switches `current` to it; `scripts/cite-one.sh` runs one
vault-cite capture, capped and serialized.

## Migration

`vault migrate` reads a JSONL manifest. A `document` entry is copied in verbatim as a source with
one passage per heading section; a `capture` entry is a vault-cite source record. Any entry whose
path, title, frontmatter, text or URL contains a deny-list keyword is reported by path or ID and not
stored, as is any entry the secret scan refuses. Matching compares letters and digits only.
`--deny-passing N` migrates a document with at most N matching sections, without those sections.
URLs a document cites resolve to saved sources where one exists; the rest are reported as unsaved
citations. Originals are only read, and rerunning a manifest converges.

## Recall log

`recall` and `research_check` append what they returned to `<root>/log/recall.jsonl`. With the op
log, which records the claims an agent went on to cite, this is the label source for a later
reranker.
