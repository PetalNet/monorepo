# Build from the repository root: docker build -f apps/janet-phone/Dockerfile <root>
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv python3-websockets python3-matrix-nio python3-qrcode \
    && rm -rf /var/lib/apt/lists/*
# The shared turn detector's runtime (wheels for the base image's Python 3.13). The venv sees the system packages above.
RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir numpy==2.1.3 onnxruntime==1.20.1
# Its models, fetched by checksum from the same pinned revisions janet-mac installs.
RUN mkdir /models \
    && fetch() { curl -fsSL --max-time 900 -o "/models/$1" "$3" && echo "$2  /models/$1" | sha256sum -c -; } \
    && fetch silero_vad.onnx 1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3 \
         https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx \
    && P=https://huggingface.co/imbcmdth/parakeet-realtime-eou-120m-onnx/resolve/974110555ac70906cbb1fe9f758cecde790d8645 \
    && fetch parakeet_vocab.txt 8fe6871fa1df0813fee690d5e5ba8dfd7a66f028b12fce32ab7d51a1d1704e6f "$P/vocab.txt" \
    && fetch parakeet_realtime_eou_120m.int8.onnx 7dbdf3e4f539a78819c71d1fc8c0aaf0be8d34417661a16e643cd47e17c319fd "$P/parakeet_realtime_eou_120m.int8.onnx"
WORKDIR /app
COPY apps/janet-phone/janet_phone.py apps/janet-phone/matrix_notice.py apps/janet-phone/pairing.py ./
COPY packages/janet-turn/janet_turn ./janet_turn
USER 1000
ENTRYPOINT ["/opt/venv/bin/python", "/app/janet_phone.py"]
