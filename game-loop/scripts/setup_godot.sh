#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_ROOT="${GODOT_INSTALL_ROOT:-$PROJECT_ROOT/.tools/godot}"
VERSION="${GODOT_VERSION:-4.6.2}"
ARCH="$(uname -m)"
OS="$(uname -s)"

mkdir -p "$INSTALL_ROOT"
TARGET="$INSTALL_ROOT/Godot_v${VERSION}-stable"

if [ -x "$TARGET" ]; then
  echo "$TARGET"
  exit 0
fi

case "$OS/$ARCH" in
  Darwin/arm64)
    ZIP="Godot_v${VERSION}-stable_macos.universal.zip"
    BIN="Godot.app/Contents/MacOS/Godot"
    ;;
  Darwin/x86_64)
    ZIP="Godot_v${VERSION}-stable_macos.universal.zip"
    BIN="Godot.app/Contents/MacOS/Godot"
    ;;
  Linux/x86_64)
    ZIP="Godot_v${VERSION}-stable_linux.x86_64.zip"
    BIN="Godot_v${VERSION}-stable_linux.x86_64"
    ;;
  *)
    echo "unsupported platform for automatic Godot install: $OS/$ARCH" >&2
    exit 2
    ;;
esac

URL="https://github.com/godotengine/godot-builds/releases/download/${VERSION}-stable/${ZIP}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -o "$TMP/godot.zip" "$URL"
unzip -q "$TMP/godot.zip" -d "$TMP/extract"
if [ "$OS" = "Darwin" ]; then
  install -m 0755 "$TMP/extract/$BIN" "$TARGET"
else
  install -m 0755 "$TMP/extract/$BIN" "$TARGET"
fi
echo "$TARGET"
