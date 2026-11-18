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

## Bridge protocol

One WebSocket per call: `GET <url>` with `Authorization: Bearer <token>`, plus
`CF-Access-Client-Id` and `CF-Access-Client-Secret` when those are set.

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
./gradlew testDebugUnitTest assembleDebug assembleRelease
```

The release build is signed with the machine's debug keystore. There is no keystore in the
repository.

## Settings

The launcher screen holds the bridge URL (`wss://`), bearer token, and Cloudflare Access client
id and secret. The token and Cloudflare values are sealed with an Android Keystore AES key. Nothing
is compiled in.

## Scripted calls (debug build only)

The debug build adds `DebugControlActivity`, which is not in the release manifest, so other apps
cannot reach settings or start calls on a release install. It also allows `ws://` for a local test
bridge.

```sh
APP=dev.petalcat.janetcall
adb install -r build/outputs/apk/debug/janet-call-android-debug.apk
adb shell pm grant $APP android.permission.RECORD_AUDIO
adb shell pm grant $APP android.permission.POST_NOTIFICATIONS

adb shell am start -n $APP/.DebugControlActivity -a $APP.PROVISION \
  --es url wss://bridge.example/v1/call --es token TOKEN \
  --es cf_id ID --es cf_secret SECRET

# A headless emulator has no microphone: stream a 16 kHz mono PCM16 WAV instead, then silence,
# and record what the app played to out.wav.
adb push in.wav /sdcard/Android/data/$APP/files/in.wav
adb shell am start -n $APP/.DebugControlActivity -a $APP.CALL --es mic in.wav --es out out.wav
adb shell am start -n $APP/.DebugControlActivity -a $APP.HANGUP
adb pull /sdcard/Android/data/$APP/files/out.wav
```
