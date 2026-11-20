# Vuln-watch

Vuln-watch collects lab inventory, matches security advisories, and tracks findings until fresh checks prove remediation. Python's standard library covers SSH subprocesses, feed requests, IMAP, and SQLite. This command-line worker has no HTTP server or additional runtime dependencies.

Runtime settings, upstream identities, vendor rules, and systemd schedules belong in `PetalNet/janet-nix`, under `modules/home/vuln-watch*`. The runtime package consumes its pinned monorepo source. Deploy only after the code merges to main and the runtime pin points to that merged revision.

## Run a scan

Use Python 3.11 or later on Linux. Keep configuration and state on local storage.

```sh
python3 apps/vuln-watch/watcher.py run --config ~/.config/vuln-watch/config.json
python3 apps/vuln-watch/watcher.py report --config ~/.config/vuln-watch/config.json
python3 apps/vuln-watch/watcher.py deliver --config ~/.config/vuln-watch/config.json
```

A scan collects current inventory unless `--inventory inventory.json` supplies an existing snapshot. It writes the inventory before fetching advisories. Add `--post` to deliver pending alerts through the configured Shawn adapter. An hourly scan uses the daily inventory with `--no-digest`; the daily inventory job produces one digest. Delivery has its own retry timer and does not fetch feeds.

`report` includes open and closed items, their evidence, the last scan's gaps, and Matrix delivery receipts. A finding stays open when a host disappears, a feed fails, a version cannot be compared, or an environmental condition is unknown. A fresh explicit unaffected check closes it. Removing a mitigation or returning to an affected version reopens it.

The watcher records patch work for Derek or compose. Operators apply changes with health checks and rollback under the lab update policy. The watcher executes no upgrades. Major upgrades, databases, Proxmox, TrueNAS, and Eli's services require their owners.

## Replay without changing live coverage

Supply an explicit inventory fixture and normalized ingestion file. Every replay post is labeled as a test. Replay files and the database live under `state_dir/replay/`.

```sh
python3 apps/vuln-watch/watcher.py replay --config config.json \
  --inventory replay-inventory.json --advisories replay-ingestion.json --post
python3 apps/vuln-watch/watcher.py report --config config.json --replay-state
python3 apps/vuln-watch/watcher.py deliver --config config.json --replay-state
```

The poster uses the existing Shawn account on .14. It accepts one configured room, refuses encrypted rooms, and uses a stable Matrix transaction ID across retries. The existing supervised System-room sender retains sole ownership of its encryption store. This adapter handles the private, unencrypted vulnerability room and returns an event ID before an alert is marked delivered.

## Data contracts

`inventory.collect(config)` returns `collected_at`, `assets`, and `gaps`. Each asset has a stable ID, host, service, product, observed version, observation time, exposure evidence, package or CPE identities, CPU flags, and mitigations. `unknown` exposure is distinct from `internal`. The collector reuses Derek's current router mapping and actual image IDs, not a pulled mutable tag. A changed Derek collector inspection expression causes collection to fail visibly rather than inspect arbitrary container fields.

`feeds.ingest(inventory, config, cache_dir)` returns normalized `advisories`, source `stats`, and `gaps`. Applicability checks have an asset ID, `affected`, `unaffected`, or `unknown` verdict, and evidence. KEV names select candidates; version and environmental checks establish applicability. OSV uses exact ecosystem, package, and observed version queries. Persisted OSV bindings require complete checks across every tracked package before closure. GitHub advisories use explicit package bindings. NVD evaluates complete CPE configuration trees, including environmental AND conditions.

A complete, fresh OSV exclusion across all tracked package bindings can supersede fresh unknown applicability checks for the same advisory and asset. Every identified GitHub package needs a version binding, and those versions must also be covered by the exclusions before an unknown check can be superseded. An unbound or partially identified package keeps applicability unknown even when another package's range is known unaffected. Fully blank GitHub package identities are repository-level candidates; complete tracked OSV exclusions can supersede them. Affected evidence still wins. Every observed version of a tracked package and every response page must be checked; stale or incomplete results cannot prove exclusion. Stale, failed, or incomplete coverage from any configured GitHub repository blocks tracked OSV exclusions for that asset.

`product_mappings` match exact observed fields, such as an image repository. `package_identities` supplies ecosystem and name; the watcher inserts the current observed version. `cpe_identity` contains `part:vendor:product`. `repositories` names upstream GitHub repositories. Reviewed `vendor_rules` can add numeric release bounds, CPU prerequisites, and effective runtime mitigation checks. The Java rule requires verified effective JVM flags from `jcmd`, rather than inferring their final value from command-line text.

Optional IMAP settings require `dedicated: true`, an allowed host, a password-file path, and an exact delivered recipient. Headers are checked before fetching bodies; only CVE IDs leave the email parser. The parser uses read-only IMAP and `BODY.PEEK`. It scans a bounded recent window and reports a gap when older messages exceed that window. No automatic list confirmation or mailbox provisioning runs inside the watcher.

## Coverage limits

Unsupported version syntax becomes unknown. Numeric range comparison does not implement Debian epochs, distribution backports, prereleases, or every ecosystem's ordering. Nix closure entries and locally built container images need reviewed upstream identities or dependency manifests before their advisory coverage can be established. Proxmox's API supplies a limited installed-package subset. Remote router backends, unavailable credentials, unknown image versions, failed feeds, pagination limits, and request budgets appear as gaps. Expired cached advisories remain available for inspection but cannot prove remediation.

Inventory freshness expires after 26 hours, including environmental observations used by NVD. Source requests have timeouts, pagination limits, and network budgets. NVD queries prioritize recent KEV additions and respect the public request limit. A gap count is not a count of distinct vulnerable services.

## Verify changes

```sh
python3 -m unittest discover -s apps/vuln-watch -v
```

The dedicated workflow runs these tests on affected pull requests. Tests cover version and CPU conditions, stale observations and caches, recipient isolation, source failures, multiple OSV bindings, replay isolation, persistence, verified closure, reopening, and delivery retries. See [PROOF.md](PROOF.md) for the live replay evidence and remaining rollout work.

`fixtures/caddy-reconciliation.json` contains selected public GitHub advisory fields, NVD configurations, and the empty OSV exact-version response saved during the November 20, 2026 Caddy remediation. The regression uses synthetic asset identities and runs ingestion through SQLite reconciliation without network access. Four of seven findings close; three remain open because their named GitHub packages have no version bindings. A mapping to the main Caddy module alone does not cover a different module path or the repository root package.
