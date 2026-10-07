# Hey Janet recording booth

Public, mobile-first voice collection for Parker's Janet wake-word training set. A set preserves the prototype's 25 positive prompts and 15 near-miss negatives. Participants give a first name and consent; PetalNet sign-in is optional. Parker reviews takes separately. Nothing here performs inference or training.

## Development

From the monorepo root, use the pinned pnpm 12.9.1 / Node 26.5.0 toolchain:

```sh
pnpm install --frozen-lockfile
pnpm --filter @petalnet/hey-janet dev --host 127.0.0.1 --port 18806
pnpm --filter @petalnet/hey-janet check
pnpm --filter @petalnet/hey-janet test
pnpm --filter @petalnet/hey-janet build
pnpm --filter @petalnet/hey-janet exec playwright install chromium webkit firefox
pnpm --filter @petalnet/hey-janet test:e2e
```

Use HTTPS outside localhost. Test sessions use an isolated `.cache/browser-recordings` directory, test-only signing key, and loopback port 18806. Firefox on headless Linux needs a running test audio server (for example PulseAudio with a null sink); CI provisions one. No test authentication bypass exists in application code. Browser tests sign their own short-lived test cookies with that isolated key. Do not use this key for deployment.

The app inherits SvelteKit 3, Svelte 5 runes, TypeScript, Tailwind 4, DaisyUI, Lucide, Vitest, Oxfmt, ESLint, Oxlint and Knip conventions. Geist is self-hosted through Fontless, with a checked-in OFL font. No font network request is required at build or runtime. The Fontless HTML-transform warning is harmless for SvelteKit: CSS generates the font faces and metrics; the root layout supplies the preload.

## Recording and recovery

An AudioWorklet captures mono PCM without MediaRecorder codec dependencies. The recorder averages samples to 16 kHz, trims surrounding silence with 150 ms lead / 250 ms tail padding, stops after 1.1 seconds of silence following detected speech or 6.5 seconds total, and writes a canonical 16-bit PCM WAV. The screen supplies a level meter, playback, redo, skip, progress, and quiet/clipping warnings. Space starts/stops recording when focus is outside another interactive control. All accepted takes are committed to IndexedDB with the next prompt position in one transaction before upload.

Each clip has a UUID upload key. Retries are idempotent and use exponential backoff capped at one minute; online events retry immediately. Accepted takes and progress survive reload. Closing the browser pauses uploads; reopening resumes them. A page reload itself needs a connection to load the app. A take being recorded or reviewed has not yet been accepted; it remains in memory until accepted. The UI does not claim it is saved. Browser storage clearing removes unuploaded takes, so keep the page open until the final uploaded confirmation.

Guest participant cookies last 30 days. Expired or mismatched cookies leave queued takes untouched and show a reconnect message. A different account/session cannot upload another participant's queue. A participant can record additional sets without filename collisions.

## Storage contract

```text
BOOTH_DATA/
  <stable-id>_<name-slug>/
    pos_00_hey-janet_<clip-uuid>.wav
    neg_25_hey-jane_<clip-uuid>.wav
    <clip-uuid>.clip.json
    clips.jsonl
```

Prompt numbering matches the prototype: positives 00–24; negatives 25–39. A guest receives a random UUID; an authenticated subject derives a stable SHA-256 ID, with the original Authentik subject retained in metadata. Name slugs cannot introduce paths. Every journal record includes file, kind, say, how, peak (PCM amplitude), duration (seconds), at (server UTC), userAgent, deviceType, participantId, participantName, authSub, setId, clipId, decision and flags. The name/id aliases keep internal participant handling simple.

Atomic clip sidecars are authoritative; `clips.jsonl` is regenerated atomically after writes and review. Retry repairs the journal if a prior request stopped after writing the sidecar. Audio is never overwritten on retry or removed by a review decision. A single application process serializes mutations; **run one replica only**. Before importing, stop the app so the importer and server cannot rewrite a journal concurrently.

Validation accepts only canonical RIFF/WAVE PCM: 16 kHz, mono, 16-bit, 0.2–8 seconds, at most 256,044 bytes. It checks header lengths, byte rate, block alignment and sample length, then calculates duration/peak/clipping itself. Browser-supplied prompt text, identity or review decisions are never trusted. Streaming body limits work without Content-Length. Low disk headroom refuses writes while clients retain their queue. Per-process limits are 600 API requests/IP/hour, 30 session starts/IP/hour, 240 uploads/participant/hour, and 4,000 stored takes/participant. Traefik adds a public request-rate limit. Restart resets the in-memory hourly limits; deploy one replica behind the documented loopback-only proxy.

## Curation and export

`/admin` and **every** review, audio and export API require a signed PetalNet session with the configured immutable Parker subject or dedicated curator group. An email address alone never grants access. OIDC uses authorization code + S256 PKCE, state and nonce; verifies JWKS signatures, issuer, audience and expiry; and retains no provider access/refresh tokens. Admin sessions expire after one hour.

Filter by participant, phrase kind, device and review status. Keep/drop/reset work on individual takes or up to 500 selected clips. Audio remains on disk. Export streams a ZIP one clip at a time:

```text
positives/pos_NN_*.wav
negatives/neg_NN_*.wav
clips.jsonl
```

Only kept clips appear. Undecided and dropped audio stays private. The ZIP journal is a snapshot of the decisions when the export begins. All private responses are `no-store`. The app does not serve BOOTH_DATA as static files.

## Parker's prototype

Voice data is private and intentionally absent from this public repository. The importer preserves all 40 WAV files byte-for-byte, records source SHA-256 hashes, retains both original journal entries for the overwritten `pos_13` take, and flags `pos_17` as `near-silent-probable-misfire`. All decisions start undecided; re-import preserves decisions.

```sh
python3 apps/hey-janet/scripts/import-prototype.py \
  /home/docker/astra-work/hey-janet-booth-src/hey-janet-booth/recordings/parker \
  apps/hey-janet/.cache/imported-recordings
```

A verified local staging copy was prepared there. The production import is part of Janet's deployment checklist; this PR does not write to the NAS.

## Deployment

See [Janet's deploy checklist](deploy/README.md). No production deployment, provider changes, router changes, NAS writes, or Docker builds on .14 are performed by this work.
