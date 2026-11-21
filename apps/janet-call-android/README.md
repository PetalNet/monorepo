# Janet for Android

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

## Receiving a call

Janet can ring this phone with `janet-ring "<reason>"` on her VM. The bridge must have incoming
calls enabled first, as described in [its setup instructions](../janet-phone/README.md#incoming-calls).
The phone validates each ring through the paired bridge before registering an incoming Telecom
call. Answer opens the normal Janet voice call. After the disclosure, Janet checks that both sides
can hear each other before giving the reason and asking for the decision.

After installing version 0.8.0 or later:

1. Open Janet once. Your existing pairing works; pair again only if Janet says the pairing is
   missing or revoked.
2. Open Settings, then **Set up incoming calls**. Grant microphone and notification access.
3. Return to Janet and tap the setup button again. Allow unrestricted battery use so the incoming
   connection can receive messages while the screen is off. On phones with vendor battery controls,
   also allow background or autostart operation for Janet.
4. On Android 14 and later, allow full-screen calls when the setup button opens that setting.
   Keep the **Incoming calls** notification channel at high importance, with ringtone and vibration.
5. To receive calls during Do Not Disturb, grant Janet Do Not Disturb access. Return to setup and
   open the Incoming calls channel, then allow it to override Do Not Disturb. Android, the phone's
   volume settings, and your channel choices determine whether it sounds.

The ongoing **Incoming call connection** notification should say **Listening for incoming calls**.
No ntfy app or Google Play Services is required. The listener uses an ntfy WebSocket in a
foreground service. It reconnects after network loss and restarts after reboot, once you unlock
the phone. Force-stopping Janet or stopping its foreground service disables delivery until you
open it again. Calls sent while the listener is disconnected can be missed because wakes are
not cached. A connection loss during a call still ends that call.

For the real-phone check, lock the phone and leave it idle. Have Janet run:

```sh
janet-ring "This is the incoming call test."
```

Answer from the lock screen and confirm that you hear the reason and can talk to Janet. Repeat
once with Decline and once without answering. Janet's command must print `declined` or `timeout`
and exit nonzero for those cases. Also test answering from the Bluetooth headset you use; that
activity handoff depends on Android and the phone vendor's background-launch rules.

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
  the RMS of 20 ms of PCM16 divided by 6000, capped at 1. A reading of her voice is shown when
  that audio reaches the speaker, not when it arrives, and the meter shows her only while she
  speaks and the caller only while she listens.
- The golden frames in `src/test/resources/planet-reference-frames.txt` come from the reference
  engine: `python3 tools/reference_frames.py path/to/ref/engine2.js` (needs node).
- The screen stays on during a call and draws about thirty frames a second. After a frame that took
  more than 7 ms it draws nothing for three times as long as the frame took, so a phone short of
  CPU slows the planet down and the call's audio keeps its threads running.

## Pairing

To enroll the owner's phone with personal Janet and lab access, use **Sign in to Janet** on the
welcome screen or in Settings. Shared-link pairing remains available for guest access.

1. Install the signed 0.9.0 update over your existing app. Keep your current pairing.
2. Open **Settings → Sign in to Janet**, or **Sign in to Janet** on an unpaired phone.
3. Check the bridge address. An already paired phone uses its current bridge. A new phone defaults
   to `wss://janet-voice.petalcat.dev/v1/call`. Use only a bridge you trust.
4. Tap **Open sign-in in browser** and sign in with an account the bridge allows.
5. Allow the browser to return to Janet. Wait for **Signed in** before leaving the sign-in screen.
6. Return to Settings and confirm **Listening for incoming calls**. Keep the incoming-call
   permissions you already granted, then test an outgoing call and a locked-screen incoming call.

**Cancel sign-in** leaves the existing pairing available. After an expired code, a refused sign-in,
or a network error, start a new sign-in. A callback works once and only for the pending request,
which lasts ten minutes. Activity and process recreation preserve the encrypted pending request.
If Android stops the process during the exchange, start a new sign-in; the prior pairing remains
unless the new pairing was already stored successfully. An in-progress or ringing call prevents
credential replacement. No existing device is revoked by this flow.

The phone creates a fresh PKCE S256 challenge and state, then opens
`GET /v1/call/pair/signin?challenge=…&state=…` on the selected bridge in the system browser.
Only `janetcall://signin?code=…&state=…` with the matching pending state is accepted.
The phone consumes that pending request before posting `{"code", "verifier", "name"}` to
`/v1/call/pair/signin` over HTTPS on the same bridge. Redirects and incomplete credentials are
refused. The bridge checks the SSO identity and allowlist; the phone supplies no identity claim.
The new credentials use the existing Android Keystore storage and restart incoming registration
only after persistence succeeds. Successful enrollment also clears the previous home-page web session.

The phone can also pair by opening a shared link.
The bridge's pairing page offers it as a button, so one tap on that page from the phone is enough:

```text
janetcall://pair?u=<base64url of UTF-8 JSON, no padding>
{"url": "wss://HOST/v1/call", "code": "<one-time code>", "expires": <unix seconds>}
```

The link holds no lasting secret. The code works once and only for a few minutes.

Any app or web page can fire that link, so the app first asks "Pair this phone with HOST?" and sends
nothing until the answer is yes.

- `url` must be `wss://HOST[:port]/v1/call` with no user, query or fragment. The app rebuilds it
  from the parsed host in lower case, so the host shown is the host called.
- A link is refused when it has expired or claims more than 15 minutes of life.
- A link is taken only when it is opened fresh. It is dropped, with a notice, during a call or while
  another confirmation is up, and it is not replayed when the app is reopened from recents.
- Pair is not where Call Janet and Hang up sit, it stays off for a second after the question
  appears, and it ignores taps that come through an overlay.

On yes, the app trades the code for its own device token and the Cloudflare Access credentials:

- `POST https://HOST/v1/call/pair` with `{"code": "...", "name": "<manufacturer model>"}` and no
  Access headers. The bridge keeps this one endpoint outside Cloudflare Access.
- `200 {"token": "<device token>", "cf_id": "...", "cf_secret": "..."}` pairs the phone. An answer
  that lacks one of the three does not.
- A `403` whose body is JSON with an `error` is the bridge saying the code was used, is wrong or
  has expired. A `429` means too many attempts, and the app says to wait a minute. Any other
  answer reads as a bridge that could not be reached. Redirects are not followed.

The URL, device token and Cloudflare Access values are stored as one value sealed with an Android
Keystore AES key. The app shows the bridge host and an Unpair button, which wipes them. There is no
screen that shows or edits a secret.

Known gaps:

- Another app on the phone can register the `janetcall` scheme and be offered the link, which
  carries the one-time code. An Android App Link on the bridge's own domain would close that.
- Unpair wipes the phone. It does not revoke the device token on the bridge.
- A physical owner sign-in, microphone audio, and locked-screen incoming call require the owner's
  handset. Unit tests and emulator checks do not establish those results.

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

## A call that survives the screen turning off

A call runs in a foreground service of type phone call and microphone. While it lasts the app also holds a
partial wake lock, a Wi-Fi lock and audio focus, so the CPU and the radio do not sleep under the microphone
thread and the socket when the screen goes off or another app comes up. They are released when the call ends.

The bridge has no way to resume a call: its conversation ends with its socket. So the app does not reconnect.
When the line is lost mid-call (the socket fails, the bridge closes it with anything but a normal close, or the
microphone stops delivering for five seconds), the app plays the fast-busy tone and says why on the call screen.
A hang-up by Janet (`bye`, or a normal close) gets no tone; her own two-note descending earcon comes from the bridge.

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

Local release builds use the machine's debug keystore and must not be installed over the owner's
app unless their signer matches. The `janet-call-android-release.yml` workflow builds merged main,
restores the existing signing key from the `android-release` environment, verifies its certificate,
and publishes one release per `versionCode`. There is no keystore in the repository.

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

# The link itself, as the pairing page opens it. This one asks for confirmation.
adb shell am start -a android.intent.action.VIEW -d "janetcall://pair?u=PAYLOAD"

# A headless emulator has no microphone: stream a 16 kHz mono PCM16 WAV instead, then silence,
# and record what the app played to out.wav.
adb push in.wav /sdcard/Android/data/$APP/files/in.wav
adb shell am start -n $APP/.DebugControlActivity -a $APP.CALL --es mic in.wav --es out out.wav
adb shell am start -n $APP/.DebugControlActivity -a $APP.HANGUP
adb pull /sdcard/Android/data/$APP/files/out.wav
```
