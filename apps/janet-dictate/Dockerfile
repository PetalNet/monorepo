# Build from the repository root. Python runs the shared ONNX decoder directly.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir numpy==2.1.3 onnxruntime==1.20.1 websockets==15.0.1
RUN mkdir /models \
    && fetch() { curl -fsSL --max-time 900 -o "/models/$1" "$3" && echo "$2  /models/$1" | sha256sum -c -; } \
    && P=https://huggingface.co/imbcmdth/parakeet-realtime-eou-120m-onnx/resolve/974110555ac70906cbb1fe9f758cecde790d8645 \
    && fetch parakeet_vocab.txt 8fe6871fa1df0813fee690d5e5ba8dfd7a66f028b12fce32ab7d51a1d1704e6f "$P/vocab.txt" \
    && fetch parakeet_realtime_eou_120m.int8.onnx 7dbdf3e4f539a78819c71d1fc8c0aaf0be8d34417661a16e643cd47e17c319fd "$P/parakeet_realtime_eou_120m.int8.onnx"
WORKDIR /app
COPY packages/janet-turn/janet_turn ./janet_turn
COPY apps/janet-dictate/janet_dictate.py ./
USER 1000
ENTRYPOINT ["/opt/venv/bin/python", "/app/janet_dictate.py"]
