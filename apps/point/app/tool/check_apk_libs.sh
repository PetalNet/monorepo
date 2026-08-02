#!/usr/bin/env bash
# R6 — publish gate. FAIL if the release APK is missing any required arm64-v8a
# native library. The Rust bridge libs come from the MANUAL rust/build-android.sh
# with no guard of its own; when that step is skipped or a lib fails to build,
# the APK ships without libpoint_mls.so / libpoint_core.so and every device
# crashes on launch — exactly what bricked 1.2.11 (pulled from F-Droid).
#
# Usage: tool/check_apk_libs.sh [path/to/app-release.apk]
# Run from apps/point/app. Wire this into CI BEFORE any publish/upload step.
set -euo pipefail

APK="${1:-build/app/outputs/flutter-apk/app-release.apk}"
ABI="arm64-v8a"
REQUIRED=(libpoint_mls.so libpoint_core.so libflutter.so libapp.so)

if [[ ! -f "$APK" ]]; then
  echo "check_apk_libs: APK not found: $APK" >&2
  exit 2
fi

# List packaged native libs once.
LIBS="$(unzip -Z1 "$APK" "lib/${ABI}/*" 2>/dev/null || true)"

missing=()
for lib in "${REQUIRED[@]}"; do
  if ! grep -qx "lib/${ABI}/${lib}" <<<"$LIBS"; then
    missing+=("$lib")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "check_apk_libs: FAIL — $APK is missing from lib/${ABI}/:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "Rebuild the Rust libs (rust/build-android.sh) before publishing." >&2
  exit 1
fi

# R11/R12 — the APK must be honestly arm64-ONLY. Any other lib/<abi>/ directory
# makes F-Droid advertise the build to that ABI's devices, which then crash on
# the missing arm64-only Rust bridge (the 1.2.11 mis-advertising bug).
stray="$(unzip -Z1 "$APK" 'lib/*' 2>/dev/null \
  | grep -oE '^lib/[^/]+/' | sort -u | grep -vx "lib/${ABI}/" || true)"
if [[ -n "$stray" ]]; then
  echo "check_apk_libs: FAIL — $APK ships non-${ABI} native code:" >&2
  sed 's/^/  - /' <<<"$stray" >&2
  echo "Strip these ABIs (build.gradle.kts packaging.jniLibs.excludes)." >&2
  exit 1
fi

echo "check_apk_libs: OK — lib/${ABI}/ has all of: ${REQUIRED[*]}; no other ABIs"
