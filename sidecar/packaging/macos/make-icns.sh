#!/usr/bin/env bash
# Build AppIcon.icns from AppIcon.png (1024x1024) using the macOS toolchain.
# Run on a Mac — needs sips + iconutil, both built in. The committed AppIcon.png
# is rasterized from AppIcon.svg; regenerate it with any SVG renderer if you edit
# the source.
set -euo pipefail
cd "$(dirname "$0")"

SRC="${1:-AppIcon.png}"
[ -f "$SRC" ] || { echo "source '$SRC' not found (expected a 1024x1024 PNG)"; exit 1; }
command -v iconutil >/dev/null 2>&1 || { echo "iconutil not found — run this on macOS"; exit 1; }

set="AppIcon.iconset"
rm -rf "$set"; mkdir -p "$set"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s"             "$SRC" --out "$set/icon_${s}x${s}.png"    >/dev/null
  sips -z "$((s*2))" "$((s*2))" "$SRC" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o AppIcon.icns
rm -rf "$set"
echo "wrote $(pwd)/AppIcon.icns"
