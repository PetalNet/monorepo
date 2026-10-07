# Multi-stage build for the Point home-server.
# Build context must be the repo root so all Cargo workspace members resolve.
FROM rust:1.96-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
# Cargo loads every workspace member, even when building only Point.
COPY apps/manager/ apps/manager/
COPY apps/dispatcher/ apps/dispatcher/
COPY apps/box-agent/ apps/box-agent/
COPY apps/control-plane/ apps/control-plane/
COPY apps/courier/crates/ apps/courier/crates/
COPY apps/point/core/ apps/point/core/
COPY apps/point/server/ apps/point/server/
RUN cargo build --release --locked -p point-server --bin point-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/point-server /usr/local/bin/point-server
EXPOSE 8330
ENTRYPOINT ["point-server"]
