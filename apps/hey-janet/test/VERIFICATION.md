# Browser and storage verification

Verified locally against the production adapter-node build on 2026-10-07. Tests use synthetic microphones and isolated local storage; no production services or participant data are exercised.

| Scenario                                         | Android Chromium, 412×839 | Desktop Chromium, 1280×720 | iPhone WebKit, 390×664 | Desktop Firefox, 1280×720 |
| ------------------------------------------------ | ------------------------- | -------------------------- | ---------------------- | ------------------------- |
| Full 40-prompt session, playback, another set    | Pass                      | Pass                       | Pass                   | Pass                      |
| Redo and skip                                    | Pass                      | Pass                       | Pass                   | Pass                      |
| Upload failure, backoff, recovery                | Pass                      | Pass                       | Pass                   | Pass                      |
| Reload with queued audio and progress            | Pass                      | Pass                       | Pass                   | Pass                      |
| Microphone denied and recovery guidance          | Pass                      | Pass                       | Pass                   | Pass                      |
| Keyboard, labels, overflow, light/dark axe scans | Pass                      | Pass                       | Pass                   | Pass                      |
| Admin boundary, bulk keep/drop, export           | Pass                      | Pass                       | Pass                   | Pass                      |
| Silent input auto-stop and quiet warning         | Pass                      | Pass                       | Pass                   | Pass                      |

The suite groups these into six scenarios per browser. A separate clipped-input warning scenario is included in CI. Chromium uses `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`. WebKit uses a real Web Audio oscillator MediaStream, installed on the MediaDevices prototype: instance overrides do not reliably persist in this WebKit. Firefox uses its fake-media preferences and a private PulseAudio null sink on headless Linux. CI installs an equivalent test audio server.

The browser run caught and fixed:

- adapter-node 6's forwarded-protocol requirement (ORIGIN no longer sets adapter request URLs).
- Svelte reactive proxies failing IndexedDB structured cloning.
- WebKit rejecting queued Blobs: the queue now stores raw ArrayBuffers.
- Retry-button tests racing successful automatic connection recovery.

The app check reports zero errors/warnings. Eight Vitest tests exercise WAV rejection and format validation, prompt counts, identity isolation, concurrent retry deduplication, metadata-only review, ZIP structure, session integrity/expiry, rate limits and OIDC signature/claim/discovery validation.

Measured light/dark text contrast is 8.49:1 or better for all active text/surface pairs, including secondary copy and accent buttons. [Measured ratios](evidence/contrast.json) record the browser-computed theme values. Disabled controls are exempt from WCAG contrast requirements. Axe's WCAG 2 A/AA and 2.1 AA checks reported no violations on recording review and curation; keyboard Space behavior and responsive overflow were checked separately.

## Screenshots

All screenshot subjects are generated test participants. No real voice data or personal participant identity is checked in.

- [Android landing](evidence/android-chromium/01-landing.png)
- [iPhone ready](evidence/iphone-webkit/02-microphone-ready.png)
- [iPhone recording](evidence/iphone-webkit/03-recording.png)
- [iPhone playback](evidence/iphone-webkit/04-playback.png)
- [iPhone near miss](evidence/iphone-webkit/05-near-miss.png)
- [iPhone thank-you](evidence/iphone-webkit/06-thank-you.png)
- [iPhone offline queue](evidence/iphone-webkit/07-offline-queue.png)
- [iPhone restored session](evidence/iphone-webkit/08-resumed.png)
- [iPhone skip](evidence/iphone-webkit/09-skip.png)
- [iPhone mic denied](evidence/iphone-webkit/10-mic-denied.png)
- [iPhone dark mode](evidence/iphone-webkit/11-dark.png)
- [iPhone curation](evidence/iphone-webkit/12-curation.png)
- [iPhone quiet auto-stop](evidence/iphone-webkit/13-quiet-auto-stop.png)

Equivalent steps exist in each browser's `test/evidence` subdirectory. CI uploads screenshots and failure traces as `hey-janet-browser-evidence` for seven days.

## Private import and archive validation

The ignored `.cache/imported-recordings/parker_parker` staging directory has 40 WAVs, 40 sidecars and 40 journal records. Every original WAV SHA-256 matches. The importer preserves all 41 source journal entries, including the overwritten pos_13 history, and flags pos_17 while leaving it undecided. Production import remains Janet's deployment step.

The exported ZIP was opened with Python's standard zipfile module, CRC-tested, and every contained WAV checked with wave for 16 kHz, one channel and two-byte samples. The application emits flat `positives/` and `negatives/` directories and a kept-only journal.

## Verification boundaries

Desktop WebKit with an iPhone viewport is not physical iOS Safari. A real iPhone HTTPS/microphone test and actual Authentik account/group validation remain explicit deployment smoke checks. Authentik was not changed or logged into during development; crypto/discovery checks use a local test issuer. Docker images must be built away from .14; no image was built here. A fully offline reload needs connectivity to load the app shell, while queued accepted audio remains in IndexedDB.
