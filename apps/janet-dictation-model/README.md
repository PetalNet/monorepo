# Private FUTO dictation model

Fine-tune FUTO’s English ACFT Whisper base or small model on one speaker’s recordings, then score the quantized model using FUTO’s decoder settings. Python provides the speech ML tooling; C++ calls libwhisper. No server or hosted inference is involved.

Audio, transcripts, prompts, checkpoints, and exported weights stay outside Git. The tool never uploads a checkpoint. Public base models and tokenizer assets download from Hugging Face. Keep output directories private, including backups. The repository contains no speaker vocabulary.

## Environment

From this directory, run the tests with CPU PyTorch:

```sh
uv run --locked --extra cpu --extra test pytest
```

For GPU training and export, prefix the Python commands below with
`uv run --locked --extra train`. On Linux the training extra uses the
PyTorch distribution from PyPI. Use it on the configured training host.

`transformers==4.46.3` pins the encoder-layer interface used for partial audio context. FUTO checkpoints lack processor files, so training loads the matching OpenAI English processor. Model weights come from FUTO. FUTO’s GGML binaries use the HF output projection as their shared token embedding; the trainer, blender and exporter use that same mapping.

On Ubuntu/WSL, `bash wsl_setup.sh` builds a pinned CPU whisper.cpp and downloads the three official English Q8_0 models. It needs uv, Git, curl and a C++ compiler. It checks published-model downloads against the hashes recorded for this experiment; interrupted downloads never become accepted `.bin` files. Let setup finish without an external short timeout.

```sh
cmake -S . -B build -DWHISPER_CPP_DIR=/opt/janet-futo/whisper.cpp -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=OFF
cmake --build build --target futo-decode -j 4
```

## Prepare recordings

`cut.py` takes one audio file per recording and a TSV with ISO timestamp, tab, recording stem. Whole recordings stay in one split. Newest recordings fill test, then validation, then training. Training audio is cut twice into long and short clips; summed training-clip duration therefore counts overlapping audio.

```sh
python cut.py --recordings /private/recordings --dates /private/dates.tsv --out /private/dataset
python label.py --clips /private/dataset/clips.jsonl --stt HOST:10300 --out /private/dataset/labels.jsonl
python data.py --clips /private/dataset/clips.jsonl --labels /private/dataset/labels.jsonl
```

The labeler reuses `../janet-voice-note`’s Wyoming client and skips completed ids. Use the lab’s large-v3-turbo server for teacher labels. These are machine references, not hand-corrected transcripts. WER against them measures agreement with that teacher.

The validator rejects duplicate or missing labels, cross-split recordings, duplicate WAV paths, truncated audio, wrong formats and mismatched durations. When moving Windows manifests to Linux, pass `--audio-root /private/dataset/clips` to map each WAV by split and basename.

## Train and export

```sh
python train.py --clips /private/dataset/clips.jsonl --labels /private/dataset/labels.jsonl \
  --audio-root /private/dataset/clips --output /private/base \
  --model futo-org/acft-whisper-base.en --gpu 4090 --epochs 3 --accumulation 8 --spec-augment
python export.py --checkpoint /private/base/best --whisper-cpp /opt/janet-futo/whisper.cpp \
  --quantize /opt/janet-futo/whisper.cpp/build/bin/whisper-quantize --out /private/base-q8.bin \
  --tokenizer-repo openai/whisper-base.en
```

Repeat with `futo-org/acft-whisper-small.en` and a separate output directory. Best checkpoints are selected by validation loss; test clips are never used for gradient updates or checkpoint selection. The partial encoder uses `clamp(ceil(samples / 320) + 32, 160, 1500)`, preserving the short contexts used by FUTO.

`--gpu 4090` verifies the physical device. `--gpu 3080-night` allows training only from 23:00 through 06:59 America/Chicago and checks before each batch and validation clip. At the end of the window it saves `last.pt`. Resume with the same arguments plus `--resume /private/base/last.pt`; it restores model, optimizer, accumulated gradients, scheduler, scaler and random state. A batch already running can finish after the boundary. Use `--memory-fraction` to cap PyTorch’s allocation. Do not change live voice environments or stop their services.

An optional private vocabulary file can be passed as `--prompt` for training and `--prompt-file` for evaluation. Compare stock and adapted models with identical prompts. Resume only checkpoints produced locally by this tool; the training state uses PyTorch’s pickle format.

## Measure the shipped binary

```sh
python evaluate.py --clips /private/dataset/clips.jsonl --labels /private/dataset/labels.jsonl \
  --audio-root /private/dataset/clips --split val --model /private/base-q8.bin \
  --decoder ./build/futo-decode --metrics /private/base-val.json --predictions /private/base-val.jsonl
```

Compare base and small on validation, then score the selected candidate once on test. Score the stock Tiny, Base and Small binaries on the same clips. Select and report quality from Q8_0 binaries, not PyTorch loss. Corpus WER uses Whisper’s English normalization and includes insertions on empty normalized references. Metrics record file hashes and decoder settings. Per-clip predictions contain private text and must remain private. Output files are created with mode 0600 and refuse to overwrite existing results.

The harness uses English, beam 5, best-of 5, zero temperature increment, blank suppression disabled, FUTO’s non-speech token list, a 256-token limit and FUTO’s dynamic audio context. It disables timestamps below 25 seconds. It runs CPU inference. This reproduces configured decoding settings; upstream whisper.cpp and FUTO’s fork can differ elsewhere. Repetition and token-limit flags need inspection, especially on short clips.

Before accepting an adapted model, export FUTO’s unmodified tiny.en checkpoint and compare it with the official tiny Q8_0 binary. Also compare the chosen adapted model with its stock counterpart on a disjoint public English speech set. Install `.[public-check]` and run `python public_data.py --out /private/librispeech --count 40 --seed 42` to prepare a reproducible LibriSpeech test-clean sample. This downloads the pinned 350 MB test-clean Parquet shard, then selects clips of 0.5–30 seconds and preserves its human transcripts. Reuse the resulting manifests with `evaluate.py --split test`. If general speech regresses, use `blend.py --adapted /private/small/best --base futo-org/acft-whisper-small.en --base-revision REVISION --alpha 0.5 --out /private/small-half`, with the revision recorded in `run.json`. Export and re-evaluate that checkpoint on validation and public speech before using the personal test split. `alpha` is the fraction of adapted weights retained. Reject a model that worsens general speech materially, loops, or fails conversion validation. Report which checks actually ran and their sample sizes. Do not infer Galaxy S23 latency from CPU measurements.

## Delivery and phone import

Publish only an accepted binary from reviewed, merged main. Store it in the owner’s authenticated Nextcloud; create no public share. Verify an anonymous download fails and an authenticated download has the recorded SHA-256.

Download the `.bin` on the phone. In FUTO Keyboard, open Settings → Languages & Models → Import resource file, select the file, choose English on “Import - Voice Input Model”, then tap Import. These labels come from FUTO’s source; phone import and device latency require a real-device check.

Upstream references: [ACFT method](https://github.com/futo-org/whisper-acft), [FUTO Keyboard](https://github.com/futo-org/android-keyboard), [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
