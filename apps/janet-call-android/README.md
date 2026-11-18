# Janet Call for Android

"Call Janet" as a real phone call on an Android phone, with no phone number. The app registers a
self-managed Telecom `PhoneAccount` and places the call through `TelecomManager.placeCall`, so
Android treats it as a call: Bluetooth and car routing, earpiece and speaker, call audio mode,
a call-log entry, and the call survives the screen locking. Audio goes over one authenticated
WebSocket to a call bridge.

It uses the platform `ConnectionService`, not `androidx.core:core-telecom`. The platform API needs
no dependency, gives the same call log and routing, and the Jetpack wrapper only adds a coroutine
layer that this single-call app has no use for.

Self-managed calls never get the system dialer screen. The app draws its own call screen
(`MainActivity`): state, hang up, and a speaker toggle. Android shows the call in the status bar,
the car and the Bluetooth headset like any other call.

## Pairing

Nothing is typed into the app and nothing is compiled in. The phone is paired by opening a link,
normally by scanning the QR code on the bridge's pairing page with the phone's camera:

```text
janetcall://pair?u=<base64url of UTF-8 JSON, no padding>
{"url": "wss://HOST/v1/call", "code": "<one-time code>", "cf_id": "...", "cf_secret": "...", "expires": <unix seconds>}
```

Any app or web page can fire that link, so the app first asks "Pair this phone with HOST?" and sends
nothing until the answer is yes. `url` must be `wss://HOST[:port]/v1/call` with no user, query or
fragment, so the host shown is the host called. An expired link is refused on the phone.

On yes, the app trades the code for its own device token:

- `POST https://HOST/v1/call/pair` with `CF-Access-Client-Id`, `CF-Access-Client-Secret` and
  `{"code": "...", "name": "<manufacturer model>"}`.
- `200 {"token": "<device token>"}` pairs the phone. `403` means the code was used or is wrong.
  Redirects are not followed.

The URL, device token and Cloudflare Access values are stored as one value sealed with an Android
Keystore AES key. The app shows the bridge host and an Unpair button, which wipes them. There is no
screen that shows or edits a secret.

## Bridge protocol

One WebSocket per call: `GET <url>` with `Authorization: Bearer <device token>`,
`CF-Access-Client-Id` and `CF-Access-Client-Secret`.

- Client to server: binary frames of 20 ms PCM16LE mono 16 kHz microphone audio, from connect to
  hang-up. Closing the socket with 1000 is the hang-up.
- Server to client:
  - `{"type":"audio","rate":N}` announces the rate of the binary frames that follow.
  - A binary frame is PCM16LE mono reply audio at that rate, played as it arrives.
  - `{"type":"clear"}` drops the audio queued for playback.
  - `{"type":"bye"}` then a normal close: Janet ended the call.
  - Unknown text types are ignored. HTTP 401 or 403 on the upgrade fails the call with a reason.

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
