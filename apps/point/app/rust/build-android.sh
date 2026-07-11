#!/usr/bin/env bash
# Build the point_mls bridge crate to per-ABI .so for the Flutter Android app.
# Requires: cargo-ndk, Android NDK. Run from apps/point/app/rust.
set -euo pipefail
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/android-sdk/ndk/28.2.13676358}"
cargo ndk -t arm64-v8a -t x86_64 -o ../android/app/src/main/jniLibs build --release
echo "Built jniLibs for arm64-v8a + x86_64."
