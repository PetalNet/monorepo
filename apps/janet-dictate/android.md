# FUTO with live voice input

Keep FUTO as the main keyboard. Use Kõnele for the lab Parakeet endpoint and Sayboard's own voice
keyboard for the offline Vosk model. Both paths produced live composing text in an Android 15
emulator. Full-sentence capture and phone acceptance remain incomplete; this is a test setup.

## Install and select

1. Install [Kõnele from F-Droid](https://f-droid.org/en/packages/ee.ioc.phon.android.speak/)
   and [Sayboard 4.2.1](https://github.com/ElishaAz/Sayboard/releases/tag/v4.2.1). The inspected Kõnele
   source is 1.9.17; the tested F-Droid APK is 1.9.16 (target SDK 34).
2. In Sayboard, grant microphone permission and download or import `vosk-model-small-en-us-0.15`
   under **Models**. Select the local English model, without a Vosk server. Downloading needs a
   network; recognition runs locally.
3. For the lab mode, enable Kõnele's **Speak & swipe keyboard** in Android's keyboard settings,
   keeping FUTO enabled. In **Speak & swipe keyboard → Recognition languages & services**, select
   **Kõnele (fast recognition)** with English (`en-US` or `en`). Enable **Partial results**.
4. Under Kõnele's **Recognition services**, open **Kõnele (fast recognition)** settings. Set the
   **Server URL** to the private `wss://…/client/ws/speech?key=…` URL from the endpoint operator.
   Select raw audio and disable **Auto stop after pause**. Language is selected in step 3.
   Keep the URL out of screenshots and shared logs.
5. In FUTO's voice-input settings, select the external engine. If an engine selector is available,
   choose the voice keyboard for the mode you want. Tested FUTO 0.1.30 instead has **Disable built-in
   voice input** and chooses an enabled voice keyboard. For that version, keep FUTO enabled and
   enable only the desired voice keyboard: Kõnele for lab mode, Sayboard for offline mode. Disable
   competing voice keyboards, including Google's, so FUTO does not select them instead.
6. Focus an empty text field and tap FUTO's microphone, then the selected voice keyboard's
   microphone. Stop when finished. Kõnele's keyboard button returns to FUTO; Sayboard has a back
   control. Switching between the two modes in FUTO 0.1.30 requires changing which voice keyboard
   is enabled in Android settings.

Do not use Kõnele's Sayboard **recognition service** as the offline configuration yet. In the API 35
emulator, Android explicitly silenced that background service's microphone and it returned empty
partials. FUTO's direct handoff to Sayboard's own keyboard produced live text with Wi-Fi and mobile
data disabled. This changes the original plan of selecting both recognizers inside Kõnele.

Stock Kõnele requires the second microphone tap. Its keyboard Auto start preference is commented
out in the inspected source. The similarly named Voice search panel option controls a different
screen. It also does not automatically return to FUTO after a final result.

The lab service finalizes when Kõnele sends `EOS`. A Parakeet end-of-utterance marker does not stop
the session. Use Kõnele's stop control when finished. Selected text suppresses partial composition
in Kõnele, so begin with an empty field and a caret.

## Observed emulator behavior

Tests used an isolated Android 15 / API 35 emulator, FUTO 0.1.30, Kõnele 1.9.16 and Sayboard 4.2.1.
Only a public LibriSpeech clip was played into the emulator microphone. Text fields were Settings
search and an unsaved contact form; no contact or message was sent or saved.

| Path                                        | Observed result                                                                                                         | Remaining limit                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| FUTO → Kõnele → lab Parakeet                | Underlined partial words appeared in the field during playback; stopping committed the opening phrase once.             | Controlled local `ws://` test only; full clip was not captured.       |
| FUTO → Sayboard's own keyboard → local Vosk | Underlined partial words appeared with Wi-Fi and mobile data both disabled; stopping committed the opening phrase once. | Full clip was not captured; physical-phone behavior remains untested. |
| Kõnele → Sayboard recognition service       | Android reported the microphone as silenced; empty partials followed.                                                   | This configuration failed the test.                                   |

Captured live-field evidence: [lab partial](proof/android-lab-partial.png) and
[offline partial](proof/android-offline-partial.png). These show composition during recording,
not successful capture of the complete clip.

The original setup downloaded Sayboard's model in-app. After emulator restarts, the test restored
that same public model into app storage and opened **Models** to reload it.

A diagnostic capture of stock Kõnele's outgoing PCM narrowed the incomplete transcript to audio
capture: a 9.92-second stream contained speech for roughly three seconds, followed by silence.
Capturing directly from the guest sound device with `tinycap` preserved the full 7.435-second clip;
replaying that capture through Parakeet recovered the entire sentence. The app recording path
remains unresolved. Early tests also hit host out-of-memory kills and are excluded from passing
results. Live field composition is established; reliable complete dictation is not.

## Phone acceptance checks

Record the current keyboard selection before testing. Use a blank local note and public test
speech, not a message composer.

- From FUTO, open each configured voice keyboard and verify the return to FUTO.
- In lab mode, speak a complete sentence. Confirm words appear in the **text field** before
  stopping, and the final replaces composing text without duplication or missing later words.
- Repeat with a pause mid-sentence, two consecutive sessions, a selected range and an empty
  recording. Check that previous committed text remains intact.
- Enable Sayboard's own keyboard for offline mode. Disable Wi-Fi and mobile data after downloading
  its model. Repeat the complete-sentence, live-text and finalization checks; restore network access.
- Return to lab mode. Check success with the configured trusted TLS certificate, and rejection
  with a wrong-host certificate, an untrusted certificate and an invalid token.
- Interrupt the network mid-utterance, stop, reconnect and retry. Verify the UI recovers and a new
  session does not inherit old text. Restore the original keyboard selection when finished.

Do not collect unrestricted logcat: the inspected Sayboard source logs hypotheses at debug level.
AndroidAsync 3.1.0, used by Kõnele, contains a trust-all fallback when default SSL-context setup
fails. Its normal path verifies hostnames and supplies SNI, but source inspection is insufficient
to establish safe TLS behavior on the target Android version. The certificate checks above remain
a release gate outside a controlled test environment. This PR does not deploy a public endpoint.

## Source evidence

- FUTO lists enabled voice-subtype IMEs in its
  [external-engine selector](https://github.com/futo-org/android-keyboard/blob/7d61ab4132cfcbb7aa713190d934f0125dc38b03/java/src/org/futo/inputmethod/latin/uix/settings/pages/VoiceInput.kt#L55-L103).
- Kõnele declares a [voice IME subtype](https://github.com/Kaljurand/K6nele/blob/0f16fe09684c371318dc1c41949cd4898802a057/app/src/main/res/xml/input_method.xml)
  and [passes partial results to its editor](https://github.com/Kaljurand/K6nele/blob/0f16fe09684c371318dc1c41949cd4898802a057/app/src/main/java/ee/ioc/phon/android/speak/service/SpeechInputMethodService.java#L409-L424).
- Sayboard's [text manager](https://github.com/ElishaAz/Sayboard/blob/0f1ee1845a9f26f3bad82493e8cfdf849b4039f3/app/src/main/java/com/elishaazaria/sayboard/ime/TextManager.kt)
  composes partials and commits final text. Its
  [local Vosk recognizer](https://github.com/ElishaAz/Sayboard/blob/0f1ee1845a9f26f3bad82493e8cfdf849b4039f3/app/src/main/java/com/elishaazaria/sayboard/recognition/recognizers/sources/VoskLocal.kt#L64-L70)
  supplies the offline model path.
- The [AndroidAsync 3.1.0 source archive](https://repo.maven.apache.org/maven2/com/koushikdutta/async/androidasync/3.1.0/androidasync-3.1.0-sources.jar)
  contains the TLS implementation used by this Kõnele revision.
