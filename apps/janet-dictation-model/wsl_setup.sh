#!/usr/bin/env bash
set -euo pipefail

work_dir=${FUTO_WORK_DIR:-/opt/janet-futo}
whisper_revision=ca19af2449df7a7f4d482fae9d809b9d0817b636
mkdir -p "$work_dir"
if [ ! -d "$work_dir/venv" ]; then
  python3 -m venv "$work_dir/venv"
fi
"$work_dir/venv/bin/python" -m pip install cmake jiwer 'transformers==4.46.3' soundfile scipy
if [ ! -d "$work_dir/whisper.cpp/.git" ]; then
  git clone https://github.com/ggml-org/whisper.cpp.git "$work_dir/whisper.cpp"
fi
git -C "$work_dir/whisper.cpp" checkout "$whisper_revision"
"$work_dir/venv/bin/cmake" -S "$work_dir/whisper.cpp" -B "$work_dir/whisper.cpp/build" \
  -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=OFF
"$work_dir/venv/bin/cmake" --build "$work_dir/whisper.cpp/build" -j 4 --target whisper whisper-cli whisper-quantize

mkdir -p "$work_dir/stock"
cd "$work_dir/stock"
while read -r model checksum; do
  file="${model}_en_acft_q8_0.bin"
  if [ -f "$file" ] && printf '%s  %s\n' "$checksum" "$file" | sha256sum --check --status; then
    continue
  fi
  curl --fail --location --retry 3 --output "$file.part" "https://voiceinput.futo.org/VoiceInput/$file"
  printf '%s  %s\n' "$checksum" "$file.part" | sha256sum --check
  mv "$file.part" "$file"
done <<'MODELS'
tiny 4b5480aa1b14a7efc5b578ef176510970a898049671c3cd237285b3e3f6bfbfc
base e9b4b7b81b8a28769e8aa9962aa39bb9f21b622cf6a63982e93f065ed5caf1c8
small 58fbe949992dafed917590d58bc12ca577b08b9957f0b3e0d7ee71b64bed3aa8
MODELS
echo SETUP-DONE
