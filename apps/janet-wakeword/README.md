# Janet wake word

Retrains the "hey Janet" [openWakeWord](https://github.com/dscripka/openWakeWord) model on
its owner's real voice and measures the result against the model it would replace. The
output is a drop-in `hey_janet.tflite` for `wyoming-openwakeword`: same graph as the
deployed model, new weights.

## What it does differently from a stock openWakeWord training

Stock openWakeWord trains a small classifier on top of a frozen speech-embedding model,
using thousands of synthetic Piper clips of the phrase, synthetic near-miss phrases, and
hours of precomputed general audio as negatives. That model never hears its owner. This
pipeline keeps that recipe and adds the owner:

| Data | Role |
| --- | --- |
| Real recordings of the owner saying "hey Janet" (a clip recorder) | positives, heavily augmented |
| The owner's own near-misses ("hey Jane", "Janet", "hey jacket") | hard negatives |
| Matrix voice notes, transcribed with word timestamps | "hey Janet" moments become positives; every other window is a negative. Bare "Janet" (being talked to, not woken) stays a hard negative |
| Chatterbox Turbo clones of each voice-note speaker | speaker-matched positives and near-misses |
| Janet's own TTS voice | negatives, so she can't wake herself on a speaker |
| Piper LibriTTS multi-speaker clips | speaker diversity, as in stock training |
| ACAV100M feature slice | general negatives, as in stock training |

Splits are made per recording before any augmentation: voice notes by a hash of the
file name (25% test, 12% val), clip-recorder takes by a frozen split plus four-fold
cross-validation. The checkpoint and threshold are chosen on val only. A region the
transcript can't vouch for (a name Whisper may have misheard, such as "Jenna") is left
unlabelled rather than called a negative.

## Running it

Everything reads and writes under `JANET_WW_ROOT`. Personal audio lives in
`$JANET_WW_ROOT/private/` (voice notes in `private/voicenotes/<speaker>/*.ogg`,
clip-recorder takes in `private/booth/`). Keep that directory on the training machine;
never commit it.

1. `transcribe.py`: Whisper large-v3-turbo word timestamps for every voice note (GPU).
2. `gen_piper.py` and `gen_chatterbox.py` (needs `CHATTERBOX_RUNTIME` and
   `JANET_WW_OWNER`): synthetic clips (GPU).
3. `build_features.py [booth notes chatterbox piper]`: labelled feature windows.
4. `extract_tflite.py` pulls the deployed model's weights into an npz, then
   `train.py <run> [--fold k]` adapts them on GPU (see "Recipe") and writes `weights.npz`.
5. `patch_tflite.py weights.npz out.tflite`: writes the weights into a copy of the
   deployed `.tflite` (`JANET_WW_BASELINE`) and checks parity against PyTorch.
6. `eval_dump.py`, then `score_tflite.py` for each model, then `metrics.py` and
   `cv_report.py`: test-set numbers for old and new through the same TFLite runtime.
   `sweep.py` prints a threshold trade-off curve for diagnosis; never pick a threshold from it.

`transcribe.py`, `gen_*`, `build_features.py` and `train.py` run in the Chatterbox GPU
environment (torch, transformers). `score_tflite.py` and `patch_tflite.py` need the
`tflite` extra on Linux.

## Recipe

Training a new head from scratch on a 12% slice of the ACAV100M negatives gave a model that
caught the owner more often but fired 3.2 times an hour on general audio, against 0.09 for
the deployed model. The deployed model's quietness comes from the full 2,000-hour negative
set, which a small slice can't replace. So the trainer adapts the deployed model instead of
replacing it:

- start from the deployed weights, constant learning rate 5e-5, at most 6,000 steps;
- positives are about 10% of each batch; negatives weigh 10, general audio 50;
- every 500 steps, the 5,000 general-audio windows the head scores highest are oversampled
  (hard-negative mining);
- a distillation term keeps the head's logits on general audio close to the deployed
  model's, which preserves its behaviour on audio the slice doesn't cover;
- the checkpoint and its threshold are chosen together on val: the lowest threshold whose
  false accepts stay under 0.3 an hour, scored by recall minus near-miss accepts. The first
  half of openWakeWord's 10.7-hour validation stream is part of val; the second half is
  test only.

Without distillation the cross-validation folds disagreed: one fold fired 10 times in 5.35
hours of the test stream. With it, every fold matched the deployed model's false accepts
exactly.

## Results (2026-11-17)

Held-out test data only. Real recordings were scored at four frame phases each, because a
single clip's score swings with where the 80 ms frame grid lands.

| | October model, threshold 0.5 | retrained, threshold 0.6 |
| --- | --- | --- |
| Owner's real "hey Janet", 4-fold CV over all 24 takes (each fold at its own val threshold) | 64/96 (67%) | 81/96 (84%) |
| Owner's real "hey Janet", 6 frozen held-out takes | 19/24 | 22/24 |
| Owner's recorded near-misses accepted, CV over 15 takes | 13/60 | 6/60 |
| Owner's near-misses accepted, 4 frozen held-out takes | 4/16 | 1/16 |
| False accepts, openWakeWord validation stream (second half, 5.35 h) | 1 | 1 |
| False accepts, held-out voice notes (79 min, two speakers) | 0 | 0 |
| False accepts, bare "Janet" in held-out notes | 0 | 0 |
| False accepts, Janet's own TTS voice (4 min) | 0 | 0 |

The model is the same graph as the deployed one, so `wyoming-openwakeword` loads it as
is. Limits: all 24 real takes come from one recording session on one microphone, and the
held-out notes contain only one "hey Janet", so recall in other rooms is unmeasured.

## Voice match (`voicematch/`)

The same voice notes also give a speaker-verification test of the owner, the "voice match"
in `docs/janet-voice/SPEC.md`. Pipeline: `sv_segments.py` cuts notes into 2-6 s speech
segments from the word timestamps; `sv_clones.py` makes the attack set; `sv_embed.py`
embeds everything with WeSpeaker ResNet-293-LM (ONNX) and SpeechBrain ECAPA-TDNN;
`sv_eval.py` scores four backends; `sv_watermark.py` checks Chatterbox's Perth watermark;
`sv_export.py` writes the chosen model.

Enrollment and every trained backend use train-split notes only. Target trials are 136
held-out segments of the owner. Non-target trials are 782 segments: another speaker
recorded on the same phone channel, plus 20 LibriSpeech test-clean speakers never used as
cohort. A quality rule drops segments that aren't speech (Whisper loops over noise), the
same rule for every speaker.

| Encoder, backend, segment length | EER | EER vs same-channel speaker | miss rate at 1% false accept |
| --- | --- | --- | --- |
| WeSpeaker ResNet-293, cosine to enrollment mean, up to 6 s | 9.6% | 11.7% | 22.1% |
| WeSpeaker ResNet-293, AS-norm, up to 6 s | 4.4% | 5.1% | 5.1% |
| WeSpeaker ResNet-293, logistic backend, up to 6 s | 2.9% | 5.1% | 5.1% |
| ECAPA-TDNN, logistic backend, up to 6 s | 4.4% | 5.1% | 5.9% |
| WeSpeaker ResNet-293, logistic backend, 2 s | 6.6% | 6.6% | 10.3% |

One held-out note probably contains a second voice; without it the best EER is 2.1%.

**Clone attack.** Chatterbox Turbo, given 8-12 s of the owner's held-out audio, said ordinary
requests ("approve the payment...") in his voice. The best plain backend accepted 71% of
the 120 clones at its EER threshold, and 61% even at the 1% false-accept threshold. Training
the backend with clones made from other references cut that to 55% and 21%, but that only
helps against the generator it was trained on. Chatterbox's Perth watermark flagged 100% of
the clones, still 100% after a 24 kbps Opus re-encode, and none of the owner's real speech.
A different TTS, or a build with the watermark removed, carries no watermark.

So voice match can decide a trust tier, as the spec says, and must never approve money.
