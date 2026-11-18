FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-websockets python3-matrix-nio \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY janet_phone.py matrix_notice.py ./
USER 1000
ENTRYPOINT ["python3", "/app/janet_phone.py"]
