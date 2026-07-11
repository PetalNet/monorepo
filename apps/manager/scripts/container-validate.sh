#!/usr/bin/env bash
# Containerized validation gate for apps/manager (N1.2 M5) — the mechanical
# way to re-run the isolated proof after any change:
#
#   cd apps/manager
#   docker run --rm --cpus=2 -v "$PWD":/src:ro rust:1.96-slim \
#     bash /src/scripts/container-validate.sh
#
# Installs the distro tmux (version is printed — the gate that caught F2 ran
# 3.5a) and runs the full Cargo-native check set, integration tests included,
# against a tmux server that lives and dies inside the container. The source
# is mounted read-only; nothing on the host is touched.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq tmux >/dev/null
echo "== tmux: $(tmux -V)"
echo "== rust: $(rustc --version)"
cp -r /src /work && cd /work
export CARGO_TARGET_DIR=/tmp/target CARGO_HOME=/tmp/cargo CARGO_BUILD_JOBS=2
echo "== fmt"
cargo fmt --check
echo "== clippy"
cargo clippy --all-targets --locked -- -D warnings
echo "== unit tests"
cargo test --locked
echo "== tmux integration tests"
N12_TMUX_IT=1 cargo test --locked --test tmux_it -- --ignored
echo "== release build"
cargo build --locked --release
echo "== ALL CONTAINER GATES GREEN"
