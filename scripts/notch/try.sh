#!/usr/bin/env bash
# Build the desktop app from this checkout and run the brain with the notch
# switch on, against data that is kept apart from any installed Jarvis.
#
#   scripts/notch/try.sh              build, then run the brain (Ctrl-C stops it)
#   scripts/notch/try.sh --token      also print a fresh enrolment token
#   scripts/notch/try.sh --no-build   skip the desktop app build
#
# On WSL it cross-builds the Windows desktop app and puts it in a folder under
# your Windows profile. On a Mac it builds Jarvis.app next to the data. The
# brain always runs here, on this machine. docs/notch/README.md has the rest.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
DATA_DIR="${NOTCH_DATA_DIR:-$HOME/.jarvis-notch}"
PORT="${NOTCH_PORT:-3143}"
DEVICE="${NOTCH_DEVICE:-notch-dev}"
BUILD=1
FRESH_TOKEN=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --token) FRESH_TOKEN=1 ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2" >&2; exit 1; }; }

need bun "Install Bun 1.3.11 or later (https://bun.sh)."
[ -d node_modules ] || { say "Installing dependencies"; bun install --frozen-lockfile; }

OS="$(uname -s)"
TARGET=""
if [ "$OS" = "Darwin" ]; then
  TARGET="mac"
elif [ "$OS" = "Linux" ] && command -v cmd.exe >/dev/null 2>&1; then
  TARGET="windows"
else
  echo "This script builds for Windows (from WSL) or macOS. On plain Linux build the desktop app with 'make -C sidecar build'." >&2
  [ "$BUILD" = 1 ] && exit 1
fi

if [ "$TARGET" = "windows" ]; then
  WIN_HOME="$(wslpath -u "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")"
  APP_DIR="${NOTCH_WIN_DIR:-$WIN_HOME/JarvisNotchDev}"
  START_HINT="$(wslpath -w "$APP_DIR")\\start-sidecar.cmd"
elif [ "$TARGET" = "mac" ]; then
  APP_DIR="${NOTCH_MAC_DIR:-$HOME/JarvisNotchDev}"
  START_HINT="$APP_DIR/start-sidecar.command"
fi

if [ "$BUILD" = 1 ] && [ "$TARGET" = "windows" ]; then
  need go "Install Go (the version in sidecar/go.mod is fetched automatically)."
  need x86_64-w64-mingw32-gcc "Install mingw-w64 (sudo apt-get install mingw-w64)."
  say "Building the Windows desktop app"
  OUT="$(mktemp -d)"
  ( cd sidecar
    CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++ \
      GOOS=windows GOARCH=amd64 CGO_ENABLED=1 \
      CGO_CFLAGS="-I$PWD/include" CGO_CXXFLAGS="-I$PWD/include" \
      go build -ldflags "-H windowsgui" -o "$OUT/jarvis.exe" . )
  mkdir -p "$APP_DIR/bin"
  if ! cp "$OUT/jarvis.exe" "$APP_DIR/bin/jarvis.exe" 2>/dev/null; then
    rm -rf "$OUT"
    echo "Could not replace $APP_DIR/bin/jarvis.exe. The test build is probably still running on Windows: quit it from its tray icon, then run this again." >&2
    exit 1
  fi
  rm -rf "$OUT"
  cp scripts/integration/start-sidecar.cmd "$APP_DIR/start-sidecar.cmd"
  echo "Desktop app: $(wslpath -w "$APP_DIR")\\bin\\jarvis.exe"
fi

if [ "$BUILD" = 1 ] && [ "$TARGET" = "mac" ]; then
  need go "Install Go (brew install go)."
  need make "Install the Xcode command line tools (xcode-select --install)."
  say "Building Jarvis.app"
  make -C sidecar build
  [ -f sidecar/packaging/macos/AppIcon.icns ] || ( cd sidecar && packaging/macos/make-icns.sh ) || true
  mkdir -p "$APP_DIR"
  make -C sidecar app-macos BIN=./jarvis APP_DIR="$APP_DIR/Jarvis.app"
  # The same idea as start-sidecar.cmd on Windows: a profile of its own, so the
  # test build never reads or writes an installed Jarvis's settings.
  cat > "$APP_DIR/start-sidecar.command" <<'EOS'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$DIR/profile"
mkdir -p "$PROFILE"
BIN="$DIR/Jarvis.app/Contents/MacOS/jarvis"
if [ -f "$PROFILE/.jarvis/sidecar.yaml" ]; then
  HOME="$PROFILE" "$BIN" >/dev/null 2>&1 &
  exit 0
fi
printf 'Paste the enrollment token: '
read -r TOKEN
[ -n "$TOKEN" ] || { echo "No token entered. Nothing started."; exit 1; }
HOME="$PROFILE" "$BIN" --token "$TOKEN" >/dev/null 2>&1 &
EOS
  chmod +x "$APP_DIR/start-sidecar.command"
  echo "Desktop app: $APP_DIR/Jarvis.app"
fi

mkdir -p "$DATA_DIR"
if [ "$FRESH_TOKEN" = 1 ] || [ ! -f "$DATA_DIR/.notch-enrolled" ]; then
  say "Enrolment token for the desktop app (paste it when the test build asks)"
  JARVIS_NOTCH=1 bun run dev:local --data-dir "$DATA_DIR" --port "$PORT" --enroll "$DEVICE"
  date > "$DATA_DIR/.notch-enrolled"
fi

say "Starting the brain with the notch switch on"
echo "Data:  $DATA_DIR   (separate from any installed Jarvis)"
echo "Brain: http://localhost:$PORT"
if [ -n "${START_HINT:-}" ]; then
  echo "Next:  quit Jarvis from its tray or menu-bar icon, then run"
  echo "       $START_HINT"
fi
echo "Ready when you see: JARVIS daemon running on port $PORT"
echo
JARVIS_NOTCH=1 exec bun run dev:local --data-dir "$DATA_DIR" --port "$PORT"
