# Vuln-watch verification, 2026-11-20

The proposed worker runs against real lab inventory and public feeds. Its persistent timers are not deployed. The runtime PR must consume the merged monorepo revision before deployment.

## Live observations

The read-only collector found 1,366 assets: 209 Docker containers on .14, 1,094 NixOS closure entries on 202, one Home Assistant installation, and 62 Proxmox entries from its limited package API and kernel status. It marked 68 assets internet-facing and left 143 versions unknown. Other exposure values remain unknown where routing evidence is incomplete.

Minecraft rejected the configured SSH key, including a connection through .14. TrueNAS returned HTTP 401 for the existing API key. Proxmox's installed-package API does not enumerate every host package. Nix closure entries, local images, and remote backends still need upstream mappings or dependency inventories. These are coverage gaps, not clean vulnerability scans.

The feed run fetched the current CISA catalog with 1,790 entries and exercised real OSV, GitHub advisory, and NVD requests. A first dry run found contradictory vendor metadata for Directus: GHSA-g65h-35f3-x2w3 declares `>=10.10.0` affected and `10.11.0` patched. The corrected parser keeps installed version `11.17.4` unknown for that record. The regression test uses those exact public fields. Initial dry-run state was retained separately; its preliminary findings were not posted as live alerts.

The final scan retained 89 product/version matches across 10 services: 27 for Directus 11.17.4, 58 across eight Caddy services on 2.11.2 or 2.11.7, and four for Home Assistant 2026.5.2. The local SQLite ledger records each advisory, asset, source, and evidence. These items remain open for patching or configuration-specific remediation checks. Other applicability checks and incomplete inventory mappings remain unresolved. No live finding posts or upgrades were applied during the dry run.

## Matrix replay receipts

Room: `!AqBUPoBENpbsJoSpbN:mx.petalcat.dev`, named `vulns`. Matrix state confirms Shawn, Parker, and Janet have joined. The room has private membership and no encryption. The adapter refuses encrypted destinations and leaves the existing System-room encryption sender unchanged.

Both events below were read back from Matrix. Their sender is `@shawn:mx.petalcat.dev`; their bodies match the stored outbox payloads and begin with `REPLAY: test inventory, not a live lab finding`.

| Case                         | Observed replay result                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Java4Shell, CVE-2026-114938  | OpenJDK 21.0.12 fixture with all required CPU flags and verified effective JVM flags produces a critical match. [Matrix event](https://matrix.to/#/!AqBUPoBENpbsJoSpbN:mx.petalcat.dev/$hu-52SLBbmwih7ug1sqZ8Xus0OtwdN-knyKCg1wzwaY) |
| Current KEV, CVE-2026-129448 | Apache Roller 6.1.4 fixture matches the vendor range, with `CISA KEV: yes`. The entry was added on 2026-11-20. [Matrix event](https://matrix.to/#/!AqBUPoBENpbsJoSpbN:mx.petalcat.dev/$-G1JTpQVxFDx3bQJRmXvEBwR8B4_9yHC87eR1Oek8Wc)  |

The Roller replay ingested the live KEV and NVD responses. NVD had no version configuration for this recent entry; a reviewed vendor rule supplied the range and mitigation. This proves the replay path, not the presence of Roller or a vulnerable JVM in the lab. The real Minecraft JVM remains unverified because SSH failed.

Repeating the replay opened zero new items and produced zero new Matrix events. The packaged Nix sender was also exercised against the same transaction IDs. Matrix returned the original event IDs on retry.

The initial labeled daily replay digest is [event $HOGjin8FyG1d-tXmCxxVwNeWA26d-St5taQuxabKtPo](https://matrix.to/#/!AqBUPoBENpbsJoSpbN:mx.petalcat.dev/$HOGjin8FyG1d-tXmCxxVwNeWA26d-St5taQuxabKtPo).

## Code and package checks

`python3 -m unittest discover -s apps/vuln-watch -v` passes 45 tests. Tests cover missing and stale inventory, stale environmental CPEs, expired feed caches, exact delivered-recipient checks before mail bodies, complete resolution across multiple OSV bindings, isolated replay files, delivery retries, mitigation verification, and reopening.

The Nix runtime package builds with `--override-input monorepo path:/home/agent/work/monorepo-vuln-watch`. Its five installed Python modules match the reviewed source byte for byte, and its installed CLI runs. The source override is a local build check, not a deployment. The normal runtime pin still predates this app.

Independent review ran through the lab router as `gpt-6.1-terra:high`. The final scoped review approved the staged code and configuration after the reported findings were fixed. The reviewer ran offline reproducers and the Python suite; live inventory, Matrix receipts, and Nix build checks were performed separately by the primary agent.

## Email and list status

Cloudflare reports petalcat.dev Email Routing enabled and ready. A dedicated `returnsvoidjanet+vulns@gmail.com` destination was requested in Janet's lab mailbox. Its verification email arrived, but Cloudflare's browser challenge prevented confirmation. There is no active `vulns@petalcat.dev` forwarding rule yet. The runtime leaves IMAP disabled and reports that gap.

All subscriptions remain pending, with no confirmed list memberships:

| List                             | Signup URL                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------- |
| oss-security                     | https://oss-security.openwall.org/subscribe                                       |
| CISA alerts                      | https://public.govdelivery.com/accounts/USDHSCISA/subscriber/new?preferences=true |
| Debian security announcements    | https://lists.debian.org/debian-security-announce/                                |
| Alpine release announcements     | https://lists.alpinelinux.org/~alpine/announce                                    |
| Node.js security                 | https://groups.google.com/g/nodejs-sec                                            |
| Authentik security announcements | https://groups.google.com/g/authentik-security-announcements                      |

Alpine announcements cover releases, not a complete security feed. NGINX's retired lists and Alpine's empty security-announcements list are excluded from subscription coverage. No Parker personal inbox was used.

Parker needs to complete Cloudflare's destination confirmation, or provide another dedicated lab inbox. After confirmation, create the exact `vulns@petalcat.dev` forwarding rule, verify delivery, subscribe the address, confirm each membership, and enable recipient-filtered IMAP ingestion. Confirmation links and mailbox credentials stay outside the repository and Matrix.

## Release dependencies

Merge the reviewed monorepo PR, update janet-nix's monorepo input to that merged main revision, and validate the runtime PR without a source override. Merge the runtime PR before applying it. Daily collection, hourly feed scans, and five-minute delivery retries then become persistent services.

Keep Minecraft access, TrueNAS credentials, incomplete package mappings, unknown versions, and remote backends open as coverage work. Patch matched internet-facing services through Derek or compose with health checks and rollback. Major upgrades, databases, Proxmox, TrueNAS, and Eli's services remain owner actions. Janet also needs to add the new room ID to her allowed rooms.
