#!/usr/bin/env bash
#
# Re-vendor github.com/webview/webview_go into sidecar/third_party/webview_go at
# a given version and re-apply the jarvis patches (jarvis.patch).
#
# We vendor + patch webview_go because upstream's Win32 engine constructor shows
# the window before WebView2 finishes initializing, producing a black flash. The
# patch creates the window hidden so the host reveals it on load. See
# sidecar/third_party/webview_go/JARVIS_PATCH.md.
#
# Usage:
#   scripts/vendor-webview.sh                # pin to the latest proxy version
#   scripts/vendor-webview.sh v0.0.0-2024... # pin to a specific version
#
# Reproducible: re-running with the current pinned version is a no-op (produces
# no git diff). The monthly .github/workflows/update-webview.yml calls this.
set -euo pipefail

MODULE="github.com/webview/webview_go"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/sidecar"
VENDOR_DIR="$SIDECAR_DIR/third_party/webview_go"
PATCH_FILE="$VENDOR_DIR/jarvis.patch"

# Files we add on top of pristine upstream; preserved across the re-copy.
KEEP_FILES=(JARVIS_PATCH.md jarvis.patch .gitattributes)

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Resolving latest $MODULE from the Go module proxy..."
  VERSION="$(curl -fsSL "https://proxy.golang.org/$MODULE/@latest" \
    | sed -n 's/.*"Version":"\([^"]*\)".*/\1/p')"
fi
[ -n "$VERSION" ] || { echo "error: could not determine a version" >&2; exit 1; }
echo "Vendoring $MODULE@$VERSION"

# Download into the module cache from a throwaway module so the sidecar's
# `replace => ./third_party/webview_go` directive doesn't shadow the fetch.
TMP_MOD="$(mktemp -d)"
trap 'rm -rf "$TMP_MOD"' EXIT
( cd "$TMP_MOD" && go mod init webview_vendor_fetch >/dev/null \
  && GOFLAGS=-mod=mod go mod download -x "$MODULE@$VERSION" )

SRC="$(go env GOMODCACHE)/$MODULE@$VERSION"
[ -d "$SRC" ] || { echo "error: module cache dir not found: $SRC" >&2; exit 1; }

# Stash the files we maintain, swap in pristine upstream, restore them.
STASH="$(mktemp -d)"
for f in "${KEEP_FILES[@]}"; do
  [ -f "$VENDOR_DIR/$f" ] && cp "$VENDOR_DIR/$f" "$STASH/"
done

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

# Copy only the buildable source set (matches the original minimal vendoring):
# top-level go/c/c++/headers, the module files, the license, and libs/. Skip
# upstream extras we don't build -- examples/, .github/, README, CHANGELOG,
# .gitignore, and *_test.go -- to keep the vendored tree lean.
shopt -s nullglob
for f in "$SRC"/*.go "$SRC"/*.cc "$SRC"/*.c "$SRC"/*.h "$SRC"/go.mod "$SRC"/go.sum "$SRC"/LICENSE*; do
  bn="$(basename "$f")"
  case "$bn" in *_test.go) continue ;; esac
  cp "$f" "$VENDOR_DIR/$bn"
done
cp -R "$SRC/libs" "$VENDOR_DIR/libs"
chmod -R u+w "$VENDOR_DIR"   # module-cache files are read-only (0444)

for f in "${KEEP_FILES[@]}"; do
  [ -f "$STASH/$f" ] && cp "$STASH/$f" "$VENDOR_DIR/$f"
done
rm -rf "$STASH"

# Re-apply our patch with GNU patch (no git-index awareness, unlike `git apply`,
# which would see the committed header as already-patched and skip). Strict on
# purpose: if upstream moved the win32 constructor this fails loudly and a human
# must regenerate jarvis.patch. Regenerate it by diffing pristine upstream
# against the patched tree for EVERY file we touch, not just the header.
echo "Applying jarvis.patch..."
( cd "$VENDOR_DIR" && patch -p1 --no-backup-if-mismatch -i "$PATCH_FILE" )

# Sanity-check the patch actually landed. One assertion PER patched behavior:
# the re-copy above restores pristine upstream over every vendored file except
# KEEP_FILES, so anything jarvis.patch stops carrying is silently reverted, the
# build still passes, and the monthly update PR goes green having dropped it.
# A grep that only covers some of the patches cannot tell that apart, so every
# hunk gets a marker here.
HEADER="$VENDOR_DIR/libs/webview/include/webview.h"
grep -q "PATCHED (jarvis)" "$HEADER"
grep -q "ShowWindow(m_window, SW_HIDE)" "$HEADER"           # win32: no open flash
grep -q "isMainThread" "$HEADER"                            # cocoa: main-thread window
grep -q "w->browser_controller()" "$HEADER"                 # reject half-built engines
grep -q "PATCHED (jarvis)" "$VENDOR_DIR/webview.go"         # nil WebView on NULL handle
grep -q "PATCHED (jarvis)" "$VENDOR_DIR/jarvis_native.go"   # browser controller accessor

# Record the pinned version (single source of truth for the update workflow).
printf '%s\n' "$VERSION" > "$VENDOR_DIR/UPSTREAM_VERSION"

# Refresh go.sum / indirect requirements against the replaced module.
( cd "$SIDECAR_DIR" && go mod tidy )

echo "Done: vendored $MODULE@$VERSION with jarvis.patch applied."
