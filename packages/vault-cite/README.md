# Vault primary-source capture

`@petalnet/vault-cite` provides the vault's EVIDENCE layer: saved bytes, SHA-256
identity, acquisition metadata, extracted text, SQLite FTS5, and generated Obsidian
source notes. It makes no model calls. Loro ingestion and EPISODES are later work.

## Commands

Run from the workspace with `pnpm --filter @petalnet/vault-cite cite <command>`.
The package also exposes the `cite` executable. Use the workspace's Node runtime;
Poppler (`pdftotext`, `pdfinfo`) and GNU tar must be available on PATH.

| Command                 | Behavior                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `add <ref>`             | Capture a URL, DOI, or arXiv ID synchronously; repeat requests reuse the saved source.        |
| `get <ref>`             | Return source metadata or the pending/inaccessible/failed job, also accepting `src-…` IDs.    |
| `search <q>`            | Search metadata and text using FTS5 syntax; return up to 30 ranked hits.                      |
| `status`                | Return durable queue counts by state.                                                         |
| `work [limit]`          | Process due jobs, up to 100 by default, including expired worker leases.                      |
| `backfill <csv>`        | Enqueue primary-scope papers from the inventory CSV and process up to 100 due jobs.           |
| `backfill <csv> --rest` | Enqueue the remaining inventory rows and process due jobs.                                    |
| `hook`                  | Read a Claude Code PreToolUse WebFetch event from stdin; capture before permitting the fetch. |

Mutation commands report saved/inaccessible/failed/retried counts. Queued retries
remain visible in `status`; run `work` again after their `next_at` time. Four
attempts exhaust transient retries. Terminal jobs are retained, not silently
retried. A disk stop leaves the job resumable.

`CITE_ROOT` selects the private storage root. Its default is
`/home/docker/vault-data/sources`; set it to the approved NAS mount at rollout.
Files have mode 0600 and the root has mode 0700. This package does not configure
NAS mounts, services, cron, agent profiles, or production hooks.

For page capture, install Chromium with
`pnpm --filter @petalnet/vault-cite exec playwright install chromium`, or point
`CITE_CHROMIUM_EXECUTABLE` at the existing lab Chromium executable. Each capture
uses a fresh context without cookies, credentials, persistent profiles, scripts,
or service workers. The PDF and single-file HTML contain the static rendered
page. Styles are flattened and fetched images are embedded; scripts, forms,
frames, media and external style/font dependencies are removed. This is a static
snapshot, not an interactive application archive. Pages requiring JavaScript,
login, or subscription may be inaccessible. arXiv citation metadata supplies titles and authors; its original abstract page
is retained as an additional artifact. Unknown PDF authors remain an empty
array and missing titles fall back to the canonical reference; metadata is never invented. Scanned PDFs without extractable text fail
until an OCR extractor is added.

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

Artifacts live at `sha256/<2>/<2>/<full-hash>/artifact`. The primary artifact has
`artifact.json` and `artifact.txt` sidecars. The JSON names every companion
artifact, including the HTML snapshot, and records the schema version, evidence
layer, source type, canonical ID, acquisition URL/time, title, authors, MIME,
extractor, SHA-256 and access status. Acquisition receipts are keyed by canonical
reference alongside the bytes. `notes/src-<20-hex>.md` is a projection with a
`source:: [[src-…]]` link example; claim relations use `supports::`,
`contradicts::` and `replaces::`. Nothing infers those claim relations.

Only successfully captured artifacts get `PRIMARY` source notes. `DIRECT`,
`DERIVED` and `GUESS` are distinct source types reserved for the later memory
layer. An inaccessible URL remains a queue record with a reason, not PRIMARY
proof. SQLite holds the durable queue and the metadata/text search projection.
The schema-versioned JSON and text sidecars allow a later Loro importer to rebuild
the source index without treating SQLite as the CRDT authority.

All downloads, including browser assets and redirect destinations, pass through
the same robots and domain pacing checks. A missing robots file (404/410) permits
access; authentication failures, unavailable robots responses, and disallows do
not. Workers persist per-host pacing, defaulting to three seconds between request
starts. Temporary failures use exponential backoff and Retry-After. Public DNS
addresses are validated and pinned for the connection. Private networks,
credential-bearing URLs and shadow-library hosts are refused. There is no access
bypass or alternate shadow-library resolver.

Responses are capped at 32 MiB; page resources at 64 MiB. Both the storage and
working filesystems must retain 35 GiB free. This includes checking before network
requests and file writes. Temporary extraction files stay under the private root.
Artifacts are renamed into place before their source enters FTS. SQLite claims
jobs atomically with a 15-minute lease, allowing recovery after worker crashes.

## Verification

`pnpm --filter @petalnet/vault-cite test` runs deterministic tests with synthetic
HTTP responses and real SQLite, PDF extraction and tar processing. Browser tests
also run when `CITE_BROWSER_TESTS=1`; they use real Chromium with intercepted
synthetic HTTP responses. No test calls an inference service.

An explicit live positive control is:

```sh
pnpm --filter @petalnet/vault-cite cite add arxiv:2307.03172v1
pnpm --filter @petalnet/vault-cite cite get arxiv:2307.03172v1
pnpm --filter @petalnet/vault-cite cite search '"Lost in the Middle"'
```

Backfill is an operator action after review. Run the papers phase first, drain its
queue, and inspect counts before selecting `--rest`. Repeating either phase does
not duplicate jobs. The inventory's existing SAVED labels do not substitute for
a verified artifact in this store.
