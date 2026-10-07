#!/usr/bin/env bash
# Containerized validation gate for apps/manager (N1.2 M5) — the mechanical
# way to re-run the isolated proof after any change:
#
#   # From the repository root:
#   docker run --rm --cpus=2 -v "$PWD":/src:ro rust:1.96-slim \
#     bash /src/apps/manager/scripts/container-validate.sh
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
mkdir -p /work
# Copy sources without the host's dependency caches or shared Cargo build state.
tar -C /src --exclude=.git --exclude=node_modules --exclude=target -cf - . | tar -C /work -xf -
cd /work
export CARGO_TARGET_DIR=/tmp/target CARGO_HOME=/tmp/cargo CARGO_BUILD_JOBS=2
echo "== fmt"
cargo fmt -p agent-manager --check
echo "== clippy"
cargo clippy -p agent-manager --all-targets --locked -- -D warnings
echo "== unit tests"
cargo test -p agent-manager --locked
echo "== tmux integration tests"
N12_TMUX_IT=1 cargo test -p agent-manager --locked --test tmux_it -- --ignored
echo "== release build"
cargo build -p agent-manager --locked --release
echo "== ALL CONTAINER GATES GREEN"
