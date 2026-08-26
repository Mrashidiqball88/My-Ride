#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ANDROID_SDK_DIR="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$ROOT_DIR/.android-sdk}}"
ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-35}"
ANDROID_BUILD_TOOLS_VERSION="${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
CMDLINE_TOOLS_VERSION="${CMDLINE_TOOLS_VERSION:-11076708}"

log() {
  printf '\n[myride-apk] %s\n' "$*"
}

fail() {
  printf '\n[myride-apk] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_command java
require_command unzip
require_command curl

if [ ! -x "$ANDROID_SDK_DIR/platform-tools/adb" ] || \
   [ ! -d "$ANDROID_SDK_DIR/platforms/android-$ANDROID_API_LEVEL" ] || \
   [ ! -d "$ANDROID_SDK_DIR/build-tools/$ANDROID_BUILD_TOOLS_VERSION" ]; then
  log "Installing Android SDK packages in $ANDROID_SDK_DIR"
  mkdir -p "$ANDROID_SDK_DIR/cmdline-tools"
  TOOLS_DIR="$ANDROID_SDK_DIR/cmdline-tools/latest"

  if [ ! -x "$TOOLS_DIR/bin/sdkmanager" ]; then
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    curl --fail --location --silent --show-error \
      "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
      --output "$TMP_DIR/commandlinetools.zip"
    rm -rf "$TOOLS_DIR"
    mkdir -p "$TOOLS_DIR"
    unzip -q "$TMP_DIR/commandlinetools.zip" -d "$TMP_DIR/unpacked"
    mv "$TMP_DIR/unpacked/cmdline-tools/"* "$TOOLS_DIR/"
  fi

  export ANDROID_HOME="$ANDROID_SDK_DIR"
  export ANDROID_SDK_ROOT="$ANDROID_SDK_DIR"
  export PATH="$ANDROID_SDK_DIR/cmdline-tools/latest/bin:$ANDROID_SDK_DIR/platform-tools:$PATH"
  yes | sdkmanager --licenses >/dev/null || true
  sdkmanager \
    "platform-tools" \
    "platforms;android-${ANDROID_API_LEVEL}" \
    "build-tools;${ANDROID_BUILD_TOOLS_VERSION}" >/dev/null
else
  export ANDROID_HOME="$ANDROID_SDK_DIR"
  export ANDROID_SDK_ROOT="$ANDROID_SDK_DIR"
  export PATH="$ANDROID_SDK_DIR/cmdline-tools/latest/bin:$ANDROID_SDK_DIR/platform-tools:$PATH"
fi

if [ ! -x ./gradlew ]; then
  log "Generating the Gradle wrapper"
  gradle wrapper --gradle-version 8.14.2 --distribution-type bin
fi

log "Building customer and driver release APKs"
./gradlew --no-daemon clean assembleCustomerRelease assembleDriverRelease

mkdir -p dist
cp -f app/build/outputs/apk/customer/release/app-customer-release.apk \
  dist/myride-customer-release.apk
cp -f app/build/outputs/apk/driver/release/app-driver-release.apk \
  dist/myride-driver-release.apk

log "Validating APK outputs"
test -s dist/myride-customer-release.apk
test -s dist/myride-driver-release.apk

printf '\nBuilt APKs:\n'
ls -lh dist/myride-customer-release.apk dist/myride-driver-release.apk