FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-websockets python3-matrix-nio python3-qrcode \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY janet_phone.py matrix_notice.py pairing.py ./
USER 1000
ENTRYPOINT ["python3", "/app/janet_phone.py"]
