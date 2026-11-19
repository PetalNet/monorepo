# FUTO with live voice input

FUTO remains the main keyboard. Kõnele is the voice keyboard; its recognition-service selector
chooses between the lab endpoint and an offline model. The following setup is based on upstream
source. Device verification is still required before claiming this works on a particular phone.

## Install and select

1. Install [Kõnele from F-Droid](https://f-droid.org/en/packages/ee.ioc.phon.android.speak/)
   and [Sayboard](https://github.com/ElishaAz/Sayboard/releases/tag/v4.2.1). The inspected Kõnele
   source is 1.9.17; F-Droid's suggested APK is 1.9.16. Do not assume they behave identically.
2. In Sayboard, grant microphone permission and download or import a small English Vosk model
   under **Models**. Use a local model, without a Vosk server. Downloading needs a network;
   recognition should not.
3. Enable Kõnele's **Speak & swipe keyboard** in Android's keyboard settings, keeping FUTO enabled.
   In Kõnele's **Speak & swipe keyboard → Recognition languages & services**, select Sayboard and
   **Kõnele (fast recognition)**. Enable **Partial results**. Sayboard can appear with language
   `und`; its service falls back to the first configured model when the requested language is absent.
4. Under Kõnele's **Recognition services**, open **Kõnele (fast recognition)** settings. Set the
   **Server URL** to the private `wss://…/client/ws/speech?key=…` URL from the endpoint operator.
   Select raw audio and English (`en-US` or `en`). Keep the URL out of screenshots and shared logs.
5. In FUTO's voice-input settings, select the external engine. If an engine selector is available,
   choose **Kõnele speak & swipe**. The tested FUTO 0.1.30 instead shows **Disable built-in voice
   input** and chooses an enabled voice keyboard. In the emulator it picked Google's voice keyboard
   first, then Kõnele after the Google voice keyboard was disabled. For that version, keep FUTO
   and Kõnele enabled and disable competing voice keyboards in Android's input-method settings.
   Sayboard's recognition service works separately from its keyboard; its keyboard need not be enabled.
6. Focus a normal text field and tap FUTO's microphone. In Kõnele, select the service to use and tap
   its microphone. Tap the keyboard button to return to FUTO after dictation.

Stock Kõnele requires that second microphone tap. Its keyboard Auto start preference is commented
out in the inspected source. The similarly named Voice search panel option controls a different
screen. It also does not automatically return to FUTO after a final result. This setup preserves
those upstream behaviors; it does not promise one-tap dictation or automatic keyboard return.

The lab service finalizes when Kõnele sends `EOS`. A Parakeet end-of-utterance marker does not stop
the session. Use Kõnele's stop control when finished. Selected text suppresses partial composition
in Kõnele, so test in an empty field with a caret first.

## Phone acceptance checks

An Android 15 / API 35 emulator with FUTO 0.1.30, Kõnele 1.9.16 and Sayboard 4.2.1 verified the
FUTO-to-Kõnele switch under the configuration above and installation of `vosk-model-small-en-us-0.15`.
That setup check did not supply microphone audio or verify recognition, composing text or TLS.

Record the current keyboard selection before testing. Use a blank local note and public test
speech, not a message composer that could send text to someone.

- From FUTO, tap the microphone and confirm that Kõnele opens. Return with its keyboard button.
- Select the lab service. While speaking a sentence, confirm that words appear in the **text
  field** before stopping. Stop; the final should replace the composing text without duplication.
- Repeat with a pause mid-sentence, two consecutive sessions, a selected range and an empty
  recording. Check that previous committed text remains intact.
- Select Sayboard's local service. Disable Wi-Fi and mobile data after downloading its model.
  Repeat the live-text and finalization checks. Restore network access afterwards.
- Re-enable the lab service. Check success with the configured trusted TLS certificate, and
  rejection with a wrong-host certificate, an untrusted certificate and an invalid token.
- Interrupt the network mid-utterance, stop, reconnect and retry. Verify the UI recovers and a new
  session does not inherit old text. Restore the original keyboard selection when finished.

Do not collect unrestricted logcat: the inspected Sayboard source logs hypotheses at debug level.
AndroidAsync 3.1.0, used by Kõnele, contains a trust-all fallback when default SSL-context setup
fails. Its normal path verifies hostnames and supplies SNI, but source inspection is insufficient
to establish safe TLS behavior on the target Android version. The certificate checks above remain
a release gate for use outside a controlled test environment.

## Source evidence

- FUTO lists enabled voice-subtype IMEs in its
  [external-engine selector](https://github.com/futo-org/android-keyboard/blob/7d61ab4132cfcbb7aa713190d934f0125dc38b03/java/src/org/futo/inputmethod/latin/uix/settings/pages/VoiceInput.kt#L55-L103).
- Kõnele declares a [voice IME subtype](https://github.com/Kaljurand/K6nele/blob/0f16fe09684c371318dc1c41949cd4898802a057/app/src/main/res/xml/input_method.xml)
  and [passes partial results to its editor](https://github.com/Kaljurand/K6nele/blob/0f16fe09684c371318dc1c41949cd4898802a057/app/src/main/java/ee/ioc/phon/android/speak/service/SpeechInputMethodService.java#L409-L424).
- Sayboard's [RecognitionService](https://github.com/ElishaAz/Sayboard/blob/0f1ee1845a9f26f3bad82493e8cfdf849b4039f3/app/src/main/java/com/elishaazaria/sayboard/services/SayboardRecognitionService.kt#L126-L163)
  sends partials and includes Kõnele-specific final handling. Its
  [Vosk local recognizer](https://github.com/ElishaAz/Sayboard/blob/0f1ee1845a9f26f3bad82493e8cfdf849b4039f3/app/src/main/java/com/elishaazaria/sayboard/recognition/recognizers/sources/VoskLocal.kt#L64-L70)
  supplies the offline model path.
- The [AndroidAsync 3.1.0 source archive](https://repo.maven.apache.org/maven2/com/koushikdutta/async/androidasync/3.1.0/androidasync-3.1.0-sources.jar)
  contains the TLS implementation used by this Kõnele revision.
