# Janet Call for Android

"Call Janet" as a real phone call on an Android phone, with no phone number. The app registers a
self-managed Telecom `PhoneAccount` and places the call through `TelecomManager.placeCall`, so
Android treats it as a call: Bluetooth and car routing, earpiece and speaker, call audio mode,
a call-log entry, and the call survives the screen locking. Audio goes over one authenticated
WebSocket to a call bridge.

It uses the platform `ConnectionService`, not `androidx.core:core-telecom`. The platform API needs
no dependency, gives the same call log and routing, and the Jetpack wrapper only adds a coroutine
layer that this single-call app has no use for.

Self-managed calls never get the system dialer screen, so the app draws its own (`CallScreen`).
Android shows the call in the status bar, the car and the Bluetooth headset like any other call.

## The call screen

The planet is the whole interface. Janet is a pixel planet that turns slowly, pulls in and spins
fast while she thinks, and goes almost still and dims while the caller talks. Under her sits a
level meter: a fixed row of columns on a dotted line, bright and wide for her voice, dimmer and
narrower for the caller's. Under that is one centred transcript line with no labels, hers bright
and his gray. The controls are speaker, Hide text or Show text, and hang up.

- `PlanetEngine` is a port of the design reference's planet engine ("meter" variant) with no
  Android imports. `PlanetEngineTest` checks it against 60 frames the reference drew.
- The planet's frames are `src/main/res/raw/planet_lit.bin`: 48 frames of a 96 x 96 grid, one bit
  per lit cell. Regenerate it from the orb engine's `orb.bin` with
  `python3 tools/export_planet.py path/to/orb.bin`. `orb.bin` is not in this repository.
- Her words are revealed on the clock of her audio. A `words` event marks a place in the playback
  queue, and the sentence starts when playback reaches it, so text never runs ahead of her voice.
- The meter shows the bridge's `level` events. After a second without one it shows levels measured
  on the phone from the audio it played and the microphone audio it sent. Both use the same scale:
  the RMS of 20 ms of PCM16 divided by 6000, capped at 1.

## Pairing

Nothing is typed into the app and nothing is compiled in. The phone is paired by opening a link,
normally by scanning the QR code on the bridge's pairing page with the phone's camera:

```text
janetcall://pair?u=<base64url of UTF-8 JSON, no padding>
{"url": "wss://HOST/v1/call", "code": "<one-time code>", "cf_id": "...", "cf_secret": "...", "expires": <unix seconds>}
```

Any app or web page can fire that link, so the app first asks "Pair this phone with HOST?" and sends
nothing until the answer is yes.

- `url` must be `wss://HOST[:port]/v1/call` with no user, query or fragment. The app rebuilds it
  from the parsed host in lower case, so the host shown is the host called.
- A link is refused when it has expired or claims more than 15 minutes of life.
- A link is taken only when it is opened fresh. It is dropped, with a notice, during a call or while
  another confirmation is up, and it is not replayed when the app is reopened from recents.
- Pair is not where Call Janet and Hang up sit, it stays off for a second after the question
  appears, and it ignores taps that come through an overlay.

On yes, the app trades the code for its own device token:

- `POST https://HOST/v1/call/pair` with `CF-Access-Client-Id`, `CF-Access-Client-Secret` and
  `{"code": "...", "name": "<manufacturer model>"}`.
- `200 {"token": "<device token>"}` pairs the phone. A `403` whose body is JSON with an `error`
  is the bridge saying the code was used or has expired. Any other `403` is Cloudflare Access.
  Redirects are not followed.

The URL, device token and Cloudflare Access values are stored as one value sealed with an Android
Keystore AES key. The app shows the bridge host and an Unpair button, which wipes them. There is no
screen that shows or edits a secret.

Known gaps:

- Another app on the phone can register the `janetcall` scheme and be offered the link, which
  carries the one-time code and the Access secret. An Android App Link on the bridge's own domain
  would close that.
- Unpair wipes the phone. It does not revoke the device token on the bridge.
- CI does not build this app.

## Bridge protocol

One WebSocket per call: `GET <url>` with `Authorization: Bearer <device token>`,
`CF-Access-Client-Id` and `CF-Access-Client-Secret`.

- Client to server: binary frames of 20 ms PCM16LE mono 16 kHz microphone audio, from connect to
  hang-up. Closing the socket with 1000 is the hang-up.
- Server to client:
  - `{"type":"audio","rate":N}` announces the rate of the binary frames that follow.
  - A binary frame is PCM16LE mono reply audio at that rate, played as it arrives.
  - `{"type":"clear"}` drops the audio queued for playback and the words she had not said yet.
  - `{"type":"bye"}` then a normal close: Janet ended the call.
  - `{"type":"state","value":"listening"|"thinking"|"speaking"}`: what Janet is doing. Without
    these the app takes whoever is audible as the one talking.
  - `{"type":"words","side":"her","text":"...","words":[{"w":"Hi","t":0.0,"d":0.18}, ...]}`, sent
    immediately before that sentence's audio. `t` is seconds from the sentence's first sample.
  - `{"type":"words","side":"him","text":"..."}`: what the caller said, shown at once.
  - `{"type":"level","her":0..1,"him":0..1}`, about ten a second.
  - Every event is optional: a bridge that sends only audio still gets the planet and a live meter.
  - Unknown text types are ignored. HTTP 401 or 403 on the upgrade fails the call with a reason.

## Warm-up

`POST https://HOST/v1/call/warm` with the device token and the Access headers asks the bridge to
load speech-to-text and the voice before they are needed. The app sends it when it comes to the
foreground while paired, at most once a minute, and again just before it places a call. The bridge
answers 202 at once. A failure is silent: the call still works, it only starts slower.

## Build

```sh
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew testDebugUnitTest testReleaseUnitTest assembleDebug assembleRelease
```

The release build is signed with the machine's debug keystore. There is no keystore in the
repository.

## Scripted calls (debug build only)

The debug build adds `DebugControlActivity`, which is not in the release manifest, so other apps
cannot pair a release install or start calls on it. It requires the `DUMP` permission, which only
`adb shell` holds, and allows `ws://` for a local test bridge. Debug and release share the
application id and signing key, so keep the debug build off the real phone.

```sh
APP=dev.petalcat.janetcall
adb install -r build/outputs/apk/debug/janet-call-android-debug.apk
adb shell pm grant $APP android.permission.RECORD_AUDIO
adb shell pm grant $APP android.permission.POST_NOTIFICATIONS

# Pair with the `u` payload of a pairing link, without the confirmation. The outcome is in logcat.
adb shell am start -n $APP/.DebugControlActivity -a $APP.PROVISION --es u PAYLOAD
adb logcat -d -s JanetCallDebug
# Or store a pairing directly, and remove it again.
adb shell am start -n $APP/.DebugControlActivity -a $APP.PROVISION \
  --es url wss://bridge.example/v1/call --es token DEVICE_TOKEN \
  --es cf_id ID --es cf_secret SECRET
adb shell am start -n $APP/.DebugControlActivity -a $APP.UNPAIR

# The link itself, as the camera would open it. This one asks for confirmation.
adb shell am start -a android.intent.action.VIEW -d "janetcall://pair?u=PAYLOAD"

# A headless emulator has no microphone: stream a 16 kHz mono PCM16 WAV instead, then silence,
# and record what the app played to out.wav.
adb push in.wav /sdcard/Android/data/$APP/files/in.wav
adb shell am start -n $APP/.DebugControlActivity -a $APP.CALL --es mic in.wav --es out out.wav
adb shell am start -n $APP/.DebugControlActivity -a $APP.HANGUP
adb pull /sdcard/Android/data/$APP/files/out.wav
```
