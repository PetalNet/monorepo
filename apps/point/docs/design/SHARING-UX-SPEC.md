# Point v1 — Sharing UX spec (build brief)

Grilled Parker × Janet 2026-07-11. **Design LOCKED — do not relitigate.** This is the client sharing UX on top of the already-shipped + proven engine (auth, server, tracking/battery engine, ghost, MLS reliability, federation, ZK recovery; two-account tracking E2E proves a synthetic client receives+decrypts a real phone's live location). Build the SCREENS that make it usable.

## Roadmap (what's IN vs OUT of v1)
- **v1 = a full standalone person-to-person location-sharing app** (this spec).
- **v1.5 = groups. v2 = bridges. v3 = guardian/supervised. (all OUT of v1.)** Also out: auto-hidden-zones, approximate/fuzzed location, Focus-style visibility modes, consent-zones.
- Logic: can't bridge location networks until you HAVE a complete one — so v1 is the standalone app first.

## 01 · Add a person
- Two paths, NO public search/directory: (a) type exact handle `user@server`; (b) shareable invite link / QR the other taps.
- Either creates a **pending share request** the other accepts. Same-server = bare username; cross-server = full handle.

## 02 · Share model
- **Mutual** ongoing share (accepted = you see each other, symmetric).
- **Precise always** (no approximate mode).
- **Ongoing by default** + a **temporary** option.

## 03 · Temp shares
- **One-way push by default**: "my live location for X min" (watch-me-get-home). They see you; you don't auto-see them; auto-expires. **UI must make the one-way direction unmistakable.**
- A **"both ways"** toggle when starting it.
- People list shows an outgoing one-way temp ("sharing till 4:30") distinctly from a two-way person.

## 04 · Ghost model (the crux)
- **Ghost = the client STOPS TRANSMITTING entirely.** No location leaves the device → server/recipient literally cannot know why you're dark (toggle vs dead phone vs no signal). Architecturally-honest deniability + battery win (GPS+relay off).
- **No notification.** Other person sees you as **"dark"**: your **frozen last-known position + "dark since HH:MM"** (what a dead phone leaves; erasing it would itself signal deliberate ghost — don't).
- Two controls: prominent global **"go dark"** (kills all sharing instantly) + per-person **"hide from them"** in each person's detail (server supports per-target).
- **Symmetric** — no guardian exception in v1.
- Visual = locked **inverse-fill + label** signal; presence by FORM not color.

### Notification/event catalog v1

A push is a contentless, per-device catch-up nudge. It is sent even when the
same user has another live WebSocket; authenticated state after refresh decides
whether Point shows local copy. The quiet-hours column records which copy may
be gated when that preference ships; it never gates data catch-up. All external
payloads remain generic: no person, place, relationship, or location detail
leaves Point through a push provider.

| Event | Audience | WS frame | Push wake | Local copy | Deep link | Quiet hours |
| --- | --- | --- | --- | --- | --- | --- |
| `share.request` | Recipient | `share.request` | Yes | “New sharing request” · “Open Point to review it.” | People · requests | Eligible; preference not in v1 |
| `share.accepted` | Both parties | `share.accepted` | Yes | “Sharing started” · “Open Point to see the update.” | Person detail | Eligible; preference not in v1 |
| `share.rejected` | Requester | `share.rejected` | Yes | In-app only | People · requests | N/A |
| `share.cancelled` | Recipient | `share.cancelled` | Yes | In-app only | People · requests | N/A |
| `share.removed` | Both parties | `share.removed` | Yes | In-app only | People | N/A |
| `share.temp_created` | Both parties’ devices | `share.temp_created` | Yes | In-app only | People | N/A |
| `share.temp_revoked` | Both parties’ devices | `share.temp_revoked` + v0 refresh nudge | Yes | In-app only | People | N/A |
| `share.temp_expired` | Both parties’ devices | Local deadline | No; clients already hold the authenticated expiry | In-app only | People | N/A |
| `mls.message` | Recipient | `mls.message` | Yes | None; encrypted sync only | None | N/A |
| `profile.changed` | Active peers | Reserved until profile fan-out ships | No | In-app only | Person detail | N/A |
| `place.arrived` / `place.departed` | Per-person/place opt-in | Reserved for the privacy-first places slice | No | Not available in v1 | Person/place | Eligible when shipped |
| `presence.stale` | Current viewer | Local derived state | No | Generic in-app staleness | Person detail | N/A |
| `presence.went_dark` | Nobody | None | **Never** | **Never** | None | N/A |

`profile.changed` and place events are catalogued but deliberately not emitted:
profile fan-out needs its owning account API, and places have no privacy domain
or detector yet. Neither may be represented as working notification plumbing.

## 05 · Core shell principle
- **Always-on is only OK because you always see who's watching.** A persistent, glanceable **"visible to N people"** status is a PRIMARY shell element — always one tap from the full who-sees-me list + per-person kill switches. Never buried in settings. This earns the always-on permission.

## 06 · People tab
- **Incoming requests pinned at top** (accept/decline).
- Active people rows: avatar + name/handle, one-line status (last place / "dark" / "location off"), last-updated.
- Temp = expiry countdown; dark/ghosted stay listed, marked (inverse-fill).
- Tap row → person detail (map focused on them + share controls / per-person hide / stop sharing).

## 07 · Map tab
- Default = centered on YOU (self-marker), neighborhood zoom, all active sharers' avatar markers.
- **Self-marker = flat photo-dot, 44dp + thin ring, center-anchored, FIXED screen size** (doesn't scale with zoom); monogram fallback with no photo; 48dp invisible hit target.
- Tap a person marker → compact bottom sheet (name, last place, last-updated, focus/directions, open detail).
- "Recenter on me" FAB; global "go dark" reachable from the map.
- Dark/location-off people don't plot (frozen last-known lives in People/detail, not a live pin).
- Provider switch (Google ↔ MapLibre) in Settings, not on the map.

## 08 · Trust & federation
- **Key verification:** invisible TOFU (just works, no crypto on the happy path) + **optional "verify"** (safety-number/QR) in person detail.
- **Federation = visible-but-quiet:** name+photo primary; `@server` handle secondary — shown where it matters, required for cross-server adds. Real, not hidden, never in-your-face.

## 09 · Onboarding & permission
- Ask **"Allow all the time" location UP FRONT** with a clear why (continuous sharing is the whole function) + the E2EE story ("only your people can ever see this — not even us"). It's a location app; own it.

## Carry-forward (already locked)
- Monochrome **Pure-Black OLED**; **Schibsted Grotesk** self-hosted; mono for tabular figures. Presence by form not color; borderless/hairlines; surface-tone ladder.
- Provider-agnostic maps (Google + MapLibre; CARTO positron-dark for MapLibre). Markers as widget CLASSES; presence off a Riverpod stream.
- Riverpod + feature-first; `very_good_analysis`, zero-analyzer-warnings gate; motion subtle+meaningful. Nav: Map / People / You. Auth outside shell; no router reset on auth change.

## Build discipline
- **PR → review → merge, no shortcuts.** No patches in builds; main serves only merged code; test on a separate domain. (Lab core rule.)
- Wire to the PROVEN engine — no facades; drive the real path end-to-end (a real second client actually receiving location).
- Every screen to the /impeccable + Flutter-playbook bar; Dart MCP render loop. Build wave by wave (Map → People → add/accept flow → ghost UX → the who-sees-me shell → temp shares → verify), carrying through without stopping between waves.
