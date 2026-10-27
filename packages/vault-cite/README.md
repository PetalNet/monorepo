# Vault primary-source capture

`@petalnet/vault-cite` provides the vault's EVIDENCE layer: saved bytes, SHA-256
identity, acquisition metadata, extracted text, SQLite FTS5, and generated Obsidian
source notes. It makes no model calls. Loro ingestion is later work; the episodes slice
below covers transcript EPISODES.

## Commands

Run from the workspace with `pnpm --filter @petalnet/vault-cite cite <command>`.
The package also exposes the `cite` executable. Use the workspace's Node runtime;
Poppler (`pdftotext`, `pdfinfo`, `pdftoppm`), Tesseract with English language data,
and GNU tar must be available on PATH. OCR runs locally without inference APIs.

| Command                            | Behavior                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `add <ref>`                        | Capture a URL, DOI, or arXiv ID synchronously; repeat requests reuse the saved source.                           |
| `add <ref> --refresh`              | Fetch again, retaining the earlier original and linking an immutable retrieval receipt.                          |
| `derive [limit]`                   | Process queued page extraction and OCR separately from capture.                                                  |
| `get <ref>`                        | Return source metadata, extraction state and retrieval history, or citation status; accepts `src-…` IDs.         |
| `search <q>`                       | Search metadata and text using FTS5 syntax; return up to 30 ranked hits.                                         |
| `status`                           | Return citation counts and individual SAVED/PENDING/BLOCKED/INACCESSIBLE states, reasons, and extraction states. |
| `work [limit]`                     | Process due captures, then queued extraction; up to 100 of each by default.                                      |
| `backfill <csv>`                   | Enqueue primary-scope papers from the inventory CSV and process up to 100 due jobs.                              |
| `backfill <csv> --rest`            | Enqueue the remaining inventory rows and process due jobs.                                                       |
| `hook`                             | Read a Claude Code PreToolUse WebFetch event from stdin; capture before permitting the fetch.                    |
| `episodes ingest <db> [batchSize]` | Stream a recall-index SQLite db into immutable, redacted episode rows (see Episodes below).                      |
| `episodes verify`                  | Re-scan indexed episode text for any known secret value's hash; exit non-zero on a hit.                          |

Mutation commands report saved/inaccessible/failed/retried counts. Queued retries
remain visible in `status`; run `work` again after their `next_at` time. Four
attempts exhaust transient retries. Terminal jobs are retained, not silently
retried. Domain pacing reports a separate `deferred` count, reschedules to the eligible
time, and never consumes a retry attempt. A disk stop leaves the job resumable. `add` saves and indexes metadata immediately;
`derive` (also run by `work`) makes document text searchable. A failed extraction
does not erase or demote a saved original. Capture failures appear as BLOCKED,
and access restrictions as INACCESSIBLE; URL-only rows never appear as SAVED.
Use `add --refresh` to explicitly retry a terminal capture.

A page whose document fetched but whose assets (images, CSS, scripts, linked
PDFs) partly failed to fetch is still SAVED, not failed: its `completeness` is
`PARTIAL`, its `missing_assets` list each asset's URL and failure reason, and
its note and `status`/`citation` rows report `SAVED_PARTIAL`. A fully fetched
page is `COMPLETE`, unchanged from before. A later `add --refresh` that fetches
every asset supersedes the partial save in place, through the same original
hash and `previous_retrieval_id`/`previous_sha256` chain as any other refresh;
a capture that regresses from COMPLETE to PARTIAL does not overwrite it.

`CITE_ROOT` selects the private storage root. Its default is
`/home/docker/vault-data/sources`; set it to the approved NAS mount at rollout.
New files, including a new `index-v2.sqlite` and its WAL, are created with mode
0600 and a new root with mode 0700. An existing root or database keeps its
permissions, so an ACL-managed NFS share that refuses `chmod` works. This package does not configure
NAS mounts, services, cron, agent profiles, or production hooks.

For page capture, install Chromium with
`pnpm --filter @petalnet/vault-cite exec playwright install chromium`, or point
`CITE_CHROMIUM_EXECUTABLE` at the existing lab Chromium executable. Each capture
uses a fresh context without cookies, credentials, persistent profiles, scripts,
or service workers. The raw HTTP HTML response is the ORIGINAL. The rendered PDF and single-file
HTML snapshot are DERIVED artifacts linked to that original by SHA-256. Styles are flattened and fetched images are embedded. Only computed styles the snapshot would not reproduce on its own are inlined: a draft diffed against tag defaults and inheritance is rendered in a blank frame, and any property that renders differently from the page is added back. Custom properties are dropped. A page fails when its render takes over 180 s or its snapshot exceeds 32 MiB. Scripts, forms,
frames, media and external style/font dependencies are removed. This is a static
snapshot, not an interactive application archive. Pages requiring JavaScript,
login, or subscription may be inaccessible. arXiv citation metadata supplies titles and authors; its original abstract page
is retained as an additional artifact. Unknown PDF authors remain an empty
array and missing titles fall back to the canonical reference; metadata is never invented.
Each PDF page is extracted by Poppler. Pages without native text are rasterized
and passed to local Tesseract; page numbers and extraction methods are retained
in a separate derived JSON artifact. OCR currently uses English language data;
images embedded alongside native page text are not separately recognized.

## Built-in capture

`Cite.remember(text, ref)` captures first and creates a memory only after a saved
primary source exists. Retrying the same text/source pair is idempotent. A crash
may leave an unreferenced captured artifact, but cannot leave a memory claiming
PRIMARY evidence that was never saved. Other harnesses call `Cite.add(ref)` and
check for a returned `source` before accepting sourced memory.

For Claude Code, the supplied hook is registered at `PreToolUse` for `WebFetch`:

```json
{
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "WebFetch",
				"hooks": [
					{
						"type": "command",
						"command": "CITE_ROOT=/private/vault/sources node /checkout/packages/vault-cite/src/cli.ts hook",
						"timeout": 180
					}
				]
			}
		]
	}
}
```

The hook returns an explicit allow/deny decision and reports counts on stderr.
Malformed events or capture errors exit 2, which blocks the tool. It saves an
independent primary acquisition before the harness fetch; it does not claim that
an agent's transformed WebFetch response is the original artifact. Install this
adapter for every supported agent profile at deployment. Other tools and shell
HTTP commands require their own harness adapters; this package does not intercept
arbitrary network traffic.

## Storage contract

Original response bodies live at `originals/sha256/<2>/<2>/<full-hash>/artifact`.
The body is saved without conversion, including HTTP content encoding if supplied;
decoding occurs only for parsing and derivation. Unrecognized formats are saved
as-is; an unsupported text extractor is reported separately as BLOCKED.

Derived snapshots, rendered PDFs and page-text/OCR JSON live under
`derived/sha256/…`. Each derived sidecar references `original_sha256`; a rendered
PDF is never the original HTML evidence. Originals have immutable `artifact.json`
sidecars; browser derivatives use `artifact.<original-hash>.json` to preserve
lineage even when derived bytes are shared by different originals. Page-text
JSON includes the original hash, page number, text and native/OCR method.

`retrievals/<uuid>.json` records each acquisition: citation reference, canonical
ID, title, authors, retrieval date, requested and final URL, HTTP status, full
Content-Type, content encoding, original hash, companion artifacts and access
status. Receipts link `previous_retrieval_id` and `previous_sha256`. A refresh with
different bytes creates a new source; identical bytes reuse the blob and retain
a new receipt. Earlier originals and receipts are never overwritten. Repeated
`add` without `--refresh` is idempotent and does not make another request.

`notes/src-<20-hex>.md` projects saved originals with a `source:: [[src-…]]` link
example; claim relations use `supports::`, `contradicts::` and `replaces::`.
Nothing infers those claim relations. `PRIMARY` describes saved evidence, while
artifact roles distinguish ORIGINAL and DERIVED. `DIRECT` and `GUESS` remain
separate memory source types. `completeness` (`COMPLETE` or `PARTIAL`) is a
separate, narrower signal: a PARTIAL source is still PRIMARY saved evidence,
just not a complete one, and its note says so alongside its `missing_assets`.

SQLite `index-v2.sqlite` holds capture and derivation queues, an explicit
`citations` status view, immutable source/receipt metadata and the FTS projection.
Only captured originals enter source FTS. Metadata is searchable before page
extraction completes. The schema-versioned sidecars support later Loro ingestion;
SQLite is not the CRDT authority. Pre-review v1 `index.sqlite` and `sha256/` data
are retained untouched and are not imported or relabelled as originals. Recapture
those references with v2 to establish trustworthy original/derived provenance.

All downloads, including browser assets and redirect destinations, pass through
the same robots checks. Documents, robots files and redirects get domain pacing.
A page's stylesheets, images and fonts are not paced: like a browser, a worker
fetches at most six at a time per host, within the page's byte and render limits. A robots client error other than 401, 403 or 429 (for example 404,
410, or the 422 that Unpaywall's API returns) permits access, per RFC 9309.
A 200 robots response is parsed as served, as RFC 9309 and major crawlers do.
An HTML page there, such as a single-page app shell or a soft 404 reached by
redirect, normally has no directive lines, so it restricts nothing.
Authentication failures, rate limits, server errors, and disallows do not. Workers persist per-host pacing, defaulting to three seconds between request
starts, and space requests across all hosts at least 400 ms apart. Requests send
a `VaultCite/0.1` User-Agent that links to this package. Temporary failures use exponential backoff and Retry-After. A 429, or a 403
carrying Retry-After or an exhausted `X-RateLimit-Remaining` (as GitHub sends),
is a rate limit: the host cools down until the reset and the job retries. Public DNS
addresses are validated and pinned for the connection. Private networks,
credential-bearing URLs and shadow-library hosts are refused. There is no access
bypass or alternate shadow-library resolver.

Responses are capped at 32 MiB; page resources at 64 MiB. Both the storage and
working filesystems must retain 35 GiB free. This includes checking before network
requests and file writes. Temporary extraction files stay under the private root.
Artifacts are renamed into place before their source enters FTS. SQLite claims
jobs atomically with a 15-minute lease, allowing recovery after worker crashes.
Deferring a request does not advance the host deadline. In-progress captures keep
successful HTTP steps in a private, lease-fenced checkpoint (up to 128 MiB per
job) so long crawl delays and worker restarts do not repeatedly fetch the first
step. Terminal jobs clear these checkpoints. Robots policies expire after one
hour and are shared across workers; request checkpoints do not cache robots
responses or persist cookie headers.

Extraction has its own leases, bounded retries and backoff. PDF title and author
fields are extracted by `pdfinfo` into a separate hash-linked metadata artifact.
They fill missing metadata in `get`, FTS and generated notes without changing
original bytes or immutable acquisition receipts, even if later page extraction
fails. PDF extraction is
limited to 500 pages, a ten-minute budget and 16 MiB text; OCR rasterization is
bounded to a 2400-pixel longest side and uses one temporary page at a time.

## Verification

`pnpm --filter @petalnet/vault-cite test` runs deterministic tests with synthetic
HTTP responses and real SQLite, PDF extraction and tar processing. Browser tests
also run when `CITE_BROWSER_TESTS=1`; they use real Chromium with intercepted
synthetic HTTP responses. No test calls an inference service. PDF/OCR-dependent tests check their executable
dependencies and skip with an explicit missing-tool reason when unavailable;
original capture, queue and network-policy tests still run. CI installs Poppler
and Tesseract so it exercises the PDF cases rather than skipping them.

An explicit live positive control is:

```sh
pnpm --filter @petalnet/vault-cite cite add arxiv:2307.03172v1
pnpm --filter @petalnet/vault-cite cite derive
pnpm --filter @petalnet/vault-cite cite get arxiv:2307.03172v1
pnpm --filter @petalnet/vault-cite cite search '"Lost in the Middle"'
```

Backfill is an operator action after review. Run the papers phase first, drain its
queue, and inspect counts before selecting `--rest`. Repeating either phase does
not duplicate jobs. The inventory's existing SAVED labels do not substitute for
a verified artifact in this store.

## Episodes

`episodes ingest <recall-db-path> [batchSize]` streams a recall-index SQLite
db (the `messages` FTS5 table `~/.claude/bin/recall-index` writes) in batches
(default 2000 rows, never the whole table at once) and writes immutable
episode rows into `episodes` + an `episode_text` FTS5 table that mirrors
`evidence`'s shape: a metadata-row table plus a parallel FTS5 text table, so a
claim can cite an episode exactly like it cites a source. Re-running against
the same db path only adds rows past the last-seen `rowid` (a per-source-path
cursor), so it never duplicates.

Redaction is **value-scoped and fail-closed**, not finding-scoped (plan
`/plan/971` comment #58 found a finding-scoped approach lets the same secret
value recur unmasked elsewhere): pass 1 scans every message in the batch
(`gitleaks` via subprocess when it is on PATH, each message written to its
own file so a finding's file name IS the message id — no line-offset
arithmetic, eliminating the spike's offset-drift bug by construction;
otherwise the built-in rules below) and collects every distinct secret value
found anywhere in the batch, plus any value matching a previously-known
secret hash (`candidateSpans`, a candidate-substring scan deliberately
WIDER than any single rule's own grammar — see secrets.ts for exactly why:
a strict superset in both length and character set is required, or a known
secret can stay unmasked wherever a recurrence doesn't carry the original
rule's triggering context). Pass 2 masks every occurrence of every collected
value in **every** message of the batch as `[REDACTED:<rule>]`. A message
with a finding whose value is empty or degenerate is dropped, never
inserted raw. Only SHA-256 hashes of confirmed secret values are persisted,
never the values themselves.

Built-in rules (used when `gitleaks` is not on PATH): `aws-access-key-id`,
`github-pat`, `slack-token`, `jwt`, `private-key-block`, `generic-api-key`
(a `key=`/`token=`/`secret=`/`password=` assignment followed by a long
opaque value). These mirror gitleaks' own rules of the same shapes; they are
a floor, not a full replacement.

`episodes verify` runs two INDEPENDENT checks over every indexed episode's
text, neither of which shares code with the ingest-side matcher (the
project's safety net must not inherit a blind spot from the matcher it
exists to audit): it re-runs the same rule-based detectors ingest uses
directly against the indexed text, and it separately re-derives candidates
with its own span generator and checks them against `known_secret_hashes`.
It exits non-zero if either check finds anything, proving zero FTS hits for
every known secret rather than trusting the ingest counts. It never logs
the matched value, only the episode id.

The known-value hash set only grows forward across ascending rowids within a
run, so a value whose only secret-shaped context arrives in a LATER batch
can't protect an EARLIER episode that already has it bare. `ingestRecallDb`
closes this gap itself: once the source db is fully drained (not stopped
early by the disk guard), it runs `sweepResidualSecrets`, which re-checks
every already-indexed episode against the final hash set and masks any
residual value in place. This is the one controlled exception to episode
immutability — it only ever narrows text (masks a value already proven
secret), never changes an id, provenance, or anything else — and
`IngestCounts.sweepMasked` reports how many episodes it touched.

Candidate generation against the known-hash set (both the cross-batch pass
during ingest and the sweep) is itself bounded: a pathological run with very
many weak delimiters is capped rather than enumerated exhaustively, since
doing so would be combinatorial. Hitting that cap is reported, never
silently absorbed — if a value itself contains one of these delimiters
(e.g. a secret with an embedded `-`), the one boundary pair that would
reconstruct it byte-for-byte might not survive capping, so a run whose
boundary count exceeds the cap is one this code CANNOT prove is free of a
known secret. The redaction pass and the sweep both fail closed on this:
redaction drops the message outright (same as an unmaskable finding);
the sweep quarantines the already-indexed episode (text replaced with a
quarantine marker, `scan_status` set to `QUARANTINED`,
`IngestCounts.sweepQuarantined` counts them) rather than leaving it
indexed on an unproven assumption of cleanliness. `episodes verify`'s own,
independently-coded candidate generator applies the identical rule: hitting
its cap counts as a hit, never as no match found.

Scope is **default-deny**: `EPISODES_SCOPE_CONFIG` (or the `scopeConfigPath`
option) points at a JSON file `{ "rooms": [...], "keywords": [...] }`. A
message whose session/room id is in `rooms`, or whose text contains any
`keywords` entry (case-insensitive substring), is dropped before redaction
or indexing — never partially redacted, never written at all. This repo
ships only `episodes.scope.example.json`; the real deny
list lives outside the repo.

An UNSET path is a deliberate no-config default: an empty deny list, with a
loud stderr warning that no exclusions are active. A path that IS set but
cannot be loaded (missing file, unmounted NAS share, invalid JSON) is a
DIFFERENT situation and fails closed: `ingestRecallDb` throws before opening
the source db or writing anything, so a broken configured path can never
silently index content an operator intended to exclude, and can never
advance the cursor past rows it never actually scoped.

`VAULT_AGENT_ID` tags each episode's `agent_id` in metadata; defaults to
`"unknown"`.

Episode content is PRIVATE tier and belongs on the NAS alongside (but not
mixed into) `vault-sources`, same as the rest of this package's storage
contract.

## Backfill scripts

`scripts/run.sh`, `scripts/worker.sh`, `scripts/guard.sh` and `scripts/diag.ts`
are the operator scripts used to drive a large backfill against the inventory
CSV. They are plain entrypoints, not imported by the package; run them from
`packages/vault-cite` or directly by path.

| Script                   | Behavior                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/run.sh`         | Enqueues the papers phase, drains the queue, then enqueues the rest of the inventory and drains again. Stops once free disk drops below `FLOOR_GIB`.             |
| `scripts/worker.sh <id>` | An extra drain loop that shares the same queue and pacing as `run.sh`; run one per worker id to add parallelism.                                                 |
| `scripts/guard.sh`       | Supervises one `worker.sh 1` loop and pauses it on real memory pressure (PSI, swap-in rate, available memory, load average), resuming after a few clean samples. |
| `scripts/diag.ts`        | `node scripts/diag.ts <store-root> <ref>...` resolves each ref on a scratch store and logs which origin's robots check or request threw.                         |

Each CLI call in `run.sh`/`worker.sh` runs as its own transient `systemd-run
--user` service with a memory cap and no swap, so a runaway page render is
OOM-killed inside its own cgroup instead of affecting the host.

Env vars (all optional, same meaning across the four scripts):

- `CITE_ROOT`: storage root; defaults to the same `/home/docker/vault-data/sources` default as the package.
- `CITE_CHROMIUM_EXECUTABLE`: Chromium headless-shell binary; autodetected under `$HOME/.cache/ms-playwright` if unset.
- `PKG`: path to this package; defaults to the scripts' own parent directory.
- `CITE_WORKDIR`: working directory for the transient CLI service; defaults to `$CITE_ROOT/backfill`.
- `CSV`: inventory CSV; defaults to `$CITE_ROOT/backfill/inventory-primary.csv`.
- `LOG`: run log path; defaults to `$CITE_ROOT/backfill/run.log`.
- `FLOOR_GIB`: free-disk stop threshold in GiB; defaults to 36 (30 inside `guard.sh`).

To run a backfill: place the inventory CSV at `$CITE_ROOT/backfill/inventory-primary.csv`,
then run `scripts/run.sh`. Add `scripts/worker.sh 2`, `scripts/worker.sh 3`, etc.
for more parallelism, or run `scripts/guard.sh` instead of a bare `worker.sh 1`
to get automatic pause/resume under memory pressure. Tail `$LOG` to watch
progress; `pending` counts (visible in the log) going to zero means the queue
is drained for that phase.
