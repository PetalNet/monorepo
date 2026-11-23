# Build from the repository root. Python runs the shared ONNX decoder directly.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
COPY --from=ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff /uv /usr/local/bin/uv
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /models \
    && fetch() { curl -fsSL --max-time 900 -o "/models/$1" "$3" && echo "$2  /models/$1" | sha256sum -c -; } \
    && P=https://huggingface.co/imbcmdth/parakeet-realtime-eou-120m-onnx/resolve/974110555ac70906cbb1fe9f758cecde790d8645 \
    && fetch parakeet_vocab.txt 8fe6871fa1df0813fee690d5e5ba8dfd7a66f028b12fce32ab7d51a1d1704e6f "$P/vocab.txt" \
    && fetch parakeet_realtime_eou_120m.int8.onnx 7dbdf3e4f539a78819c71d1fc8c0aaf0be8d34417661a16e643cd47e17c319fd "$P/parakeet_realtime_eou_120m.int8.onnx" \
    && fetch LICENSE 65e8ba6069b1263ce3a473e2e466a07e68c8d85c6b4c3805616eb3e357af1008 "$P/LICENSE" \
    && fetch NOTICE 5fc60716a9ba57f3792e71ed776b4065671c64d0c2db716698f4d646ad833eb1 "$P/NOTICE"
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1 UV_LINK_MODE=copy
RUN --mount=type=bind,target=/workspace,rw \
    uv sync --project /workspace --locked --package janet-dictate --no-editable --no-dev
WORKDIR /app
USER 1000
ENTRYPOINT ["/opt/venv/bin/janet-dictate"]
