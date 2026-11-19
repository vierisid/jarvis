#!/usr/bin/env bash
# Build the desktop app from this checkout and run the brain with the notch
# switch on, against data that is kept apart from any installed Jarvis.
#
#   scripts/notch/try.sh              build, start everything (Ctrl-C stops the brain)
#   scripts/notch/try.sh --token      also print a fresh enrolment token
#   scripts/notch/try.sh --no-build   skip the desktop app build
#   scripts/notch/try.sh --no-start   do not start the desktop app
#
# On WSL it cross-builds the Windows desktop app into a folder under your
# Windows profile, restarts it, and runs the brain here. On a Mac it builds
# Jarvis.app next to the data. docs/notch/README.md has the rest.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
DATA_DIR="${NOTCH_DATA_DIR:-$HOME/.jarvis-notch}"
PORT="${NOTCH_PORT:-3143}"
DEVICE="${NOTCH_DEVICE:-notch-dev}"
BUILD=1
FRESH_TOKEN=0
START=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --token) FRESH_TOKEN=1 ;;
    --no-start) START=0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Which jarvis.exe is running, if any: "test" for the one in APP_DIR, "other"
# for any other (an installed Jarvis), empty for none.
running_jarvis() {
  local dir paths
  dir="$(wslpath -w "$APP_DIR" | tr '[:upper:]' '[:lower:]')"
  paths="$(powershell.exe -NoProfile -Command "Get-Process jarvis -ErrorAction SilentlyContinue | ForEach-Object { \$_.Path }" 2>/dev/null | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  [ -n "$paths" ] || return 0
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    case "$path" in "$dir"\\*) ;; *) echo other; return 0 ;; esac
  done <<< "$paths"
  echo test
}

if [ "$TARGET" = "windows" ]; then
  case "$(running_jarvis)" in
    other)
      echo "Jarvis is running on Windows. Quit it from its tray icon, then run this again: the test build cannot run beside it." >&2
      exit 1 ;;
    test)
      if [ "$BUILD" = 1 ] || [ "$START" = 1 ]; then
        say "Stopping the test build that is still running"
        powershell.exe -NoProfile -Command "Get-Process jarvis -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true
        # Stopped is not gone: wait until Windows no longer lists it.
        for _ in $(seq 1 20); do
          [ -z "$(running_jarvis)" ] && break
          sleep 0.5
        done
      fi ;;
  esac
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
  # Windows keeps a program's file locked for a moment after the program has
  # gone. When nothing had to be compiled the build is over in seconds, sooner
  # than that, so the copy is tried for a while before giving up.
  COPIED=0
  for _ in $(seq 1 20); do
    if cp "$OUT/jarvis.exe" "$APP_DIR/bin/jarvis.exe" 2>/dev/null; then COPIED=1; break; fi
    sleep 1
  done
  if [ "$COPIED" != 1 ]; then
    rm -rf "$OUT"
    echo "Could not replace $APP_DIR/bin/jarvis.exe after 20 seconds. The test build is probably still running on Windows: quit it from its tray icon, then run this again." >&2
    exit 1
  fi
  rm -rf "$OUT"
  cp scripts/integration/start-sidecar.cmd "$APP_DIR/start-sidecar.cmd"
  echo "Desktop app: $(wslpath -w "$APP_DIR")\\bin\\jarvis.exe"
fi

# A local build is unsigned. Windows Smart App Control lets some unsigned
# programs run and refuses others, per file. Find out now, and say so, instead
# of starting a brain that no desktop app will ever join.
if [ "$TARGET" = "windows" ] && [ -f "$APP_DIR/bin/jarvis.exe" ]; then
  if ! (cd "$APP_DIR" && timeout 30 ./bin/jarvis.exe --version >/dev/null 2>&1); then
    echo >&2
    echo "Windows refused to run this build of the desktop app." >&2
    echo "The usual cause is Smart App Control, which blocks programs that are not signed." >&2
    echo "Nothing was started. See \"When Windows refuses the build\" in docs/notch/README.md." >&2
    exit 1
  fi
fi

if [ "$BUILD" = 1 ] && [ "$TARGET" = "mac" ]; then
  need go "Install Go (brew install go)."
  need make "Install the Xcode command line tools (xcode-select --install)."
  mkdir -p "$APP_DIR"
  # The test build is its own program to macOS, with a name of its own in the
  # lists of permissions. With the installed Jarvis's name it shared that
  # one's switches, and a switch belongs to the program it was made for: one
  # left by another build shows as on and does nothing.
  MAC_BUNDLE_ID="com.jarvis.sidecar.notchdev"
  # It is built again only when its code changed. A rebuilt app is a new
  # program to macOS, and every permission has to be given again; the page and
  # the brain change far more often than the desktop app does.
  BUILT_FROM="$APP_DIR/.built-from"
  SIDECAR_NOW="$(git rev-parse HEAD:sidecar 2>/dev/null || true)"
  [ -z "$(git status --porcelain -- sidecar 2>/dev/null)" ] || SIDECAR_NOW=""
  if [ -n "$SIDECAR_NOW" ] && [ -x "$APP_DIR/Jarvis.app/Contents/MacOS/jarvis" ] && [ "$(cat "$BUILT_FROM" 2>/dev/null)" = "$MAC_BUNDLE_ID $SIDECAR_NOW" ]; then
    say "Jarvis.app is already built from this code"
    echo "Kept as it is, so the permissions it was given in System Settings still hold."
  else
    say "Building Jarvis.app"
    rm -f "$BUILT_FROM"
    make -C sidecar build
    # What reads text off the screen is a small helper of its own. Without it the app runs, and reads nothing.
    make -C sidecar build-ocr-helper || echo "The helper that reads text off the screen was not built. Everything else goes on without it."
    [ -f sidecar/packaging/macos/AppIcon.icns ] || ( cd sidecar && packaging/macos/make-icns.sh ) || true
    make -C sidecar app-macos BIN=./jarvis APP_DIR="$APP_DIR/Jarvis.app"
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $MAC_BUNDLE_ID" "$APP_DIR/Jarvis.app/Contents/Info.plist" || {
      echo "The test build could not be given its own name for macOS. It keeps the installed Jarvis's."
      MAC_BUNDLE_ID="com.jarvis.sidecar"
    }
    # Signed for this Mac only, as the app it says it is. Left as the build
    # makes it, the program inside is signed by the linker under the name
    # "a.out", and the app round it is not signed at all: macOS then lists
    # "Jarvis" under a permission and does not find it behind the program that
    # runs (the second run on a Mac, 19 November 2026). No certificate is
    # involved and nothing is sent anywhere: this is the signature a build made
    # on the Mac itself gets. Inside first, then the app.
    if command -v codesign >/dev/null 2>&1; then
      SIGNED=1
      if [ -f "$APP_DIR/Jarvis.app/Contents/MacOS/ocr-helper" ]; then
        codesign --force --sign - "$APP_DIR/Jarvis.app/Contents/MacOS/ocr-helper" || SIGNED=0
      fi
      codesign --force --sign - "$APP_DIR/Jarvis.app" || SIGNED=0
      if [ "$SIGNED" = 1 ]; then
        echo "Signed for this Mac: $(codesign -dv "$APP_DIR/Jarvis.app" 2>&1 | grep -E '^Identifier=' || echo 'identifier not read')"
      else
        echo "The app could not be signed for this Mac. It runs, and macOS may not honour a permission given to it."
      fi
    else
      echo "codesign is not on this Mac (Xcode command line tools): the app is not signed, and macOS may not honour a permission given to it."
    fi
    # The switches of the build before this one are cleared: they are for a
    # program that no longer exists, and they would show as on (the third run
    # on a Mac: on in the list, refused by macOS). Only ever the test build's
    # own; an installed Jarvis's are never touched from here.
    if [ "$MAC_BUNDLE_ID" != "com.jarvis.sidecar" ] && command -v tccutil >/dev/null 2>&1; then
      # macOS has to know the app before it can clear anything of it: an app
      # that was only just built is not known yet, and the clearing then fails
      # with "No such bundle identifier" (the fifth run on a Mac).
      LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
      [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP_DIR/Jarvis.app" >/dev/null 2>&1 || true
      tccutil reset All "$MAC_BUNDLE_ID" >/dev/null 2>&1 || true
      echo "New build: macOS has to be told again what it may do (System Settings, Privacy & Security)."
      echo "What the build before it was given has been cleared, so nothing there shows as on that is not."
    fi
    [ -z "$SIDECAR_NOW" ] || echo "$MAC_BUNDLE_ID $SIDECAR_NOW" > "$BUILT_FROM"
  fi
  # The same idea as start-sidecar.cmd on Windows: a profile of its own, so the
  # test build never reads or writes an installed Jarvis's settings.
  #
  # It is started as an app (`open`), not as a program from this terminal. macOS
  # gives a permission to whoever started the program: started from a terminal,
  # the Accessibility permission the keys need would be the terminal's to have,
  # and switching it on for Jarvis.app would change nothing. That is what the
  # first run on a Mac met (19 November 2026). What the app logs goes to
  # app.log beside it (a crash too), and what it prints to app.out.log.
  cat > "$APP_DIR/start-sidecar.command" <<'EOS'
#!/bin/bash
# start-sidecar.command [token]
DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$DIR/profile"
mkdir -p "$PROFILE"
APP="$DIR/Jarvis.app"
LOG="$DIR/app.log"
OUT="$DIR/app.out.log"
TOKEN="${1:-}"
# One at a time: a second one would be a second notch, and the first keeps
# running with whatever macOS allowed it when it started.
if pgrep -f "$APP/Contents/MacOS/jarvis" >/dev/null 2>&1; then
  echo "Jarvis from this folder is already running. Quit it first (its menu bar icon, Quit), then run this again."
  exit 1
fi
if [ -f "$PROFILE/.jarvis/sidecar.yaml" ]; then
  open -n "$APP" --env HOME="$PROFILE" --stdout "$OUT" --stderr "$LOG"
  exit 0
fi
if [ -z "$TOKEN" ]; then
  printf 'Paste the enrollment token: '
  read -r TOKEN
fi
[ -n "$TOKEN" ] || { echo "No token entered. Nothing started."; exit 1; }
open -n "$APP" --env HOME="$PROFILE" --stdout "$OUT" --stderr "$LOG" --args --token "$TOKEN"
EOS
  chmod +x "$APP_DIR/start-sidecar.command"
  echo "Desktop app: $APP_DIR/Jarvis.app"
fi

mkdir -p "$DATA_DIR"
# The token that was just made, when one was. A desktop app that has never
# been enrolled is started with it below, so there is nothing to paste: the
# token is printed many lines above where the eye is once the brain talks.
TOKEN=""
if [ "$FRESH_TOKEN" = 1 ] || [ ! -f "$DATA_DIR/.notch-enrolled" ]; then
  say "Enrolment token for the desktop app"
  ENROLLED="$(JARVIS_NOTCH=1 bun run dev:local --data-dir "$DATA_DIR" --port "$PORT" --enroll "$DEVICE")"
  printf '%s\n' "$ENROLLED"
  TOKEN="$(printf '%s\n' "$ENROLLED" | grep -E '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' | tail -n 1 || true)"
  date > "$DATA_DIR/.notch-enrolled"
fi
# Whether this folder's desktop app has been enrolled before.
NEW_APP=0
if [ -n "${APP_DIR:-}" ] && [ ! -f "$APP_DIR/profile/.jarvis/sidecar.yaml" ]; then NEW_APP=1; fi

# The demo endpoint wants a secret (src/notch/demo-gate.ts). One is made once
# and kept beside the test data, where scripts/notch/demo.sh and fixture.sh
# find it.
DEMO_SECRET_FILE="$DATA_DIR/.notch-demo-secret"
if [ ! -s "$DEMO_SECRET_FILE" ]; then
  (umask 077 && head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DEMO_SECRET_FILE")
fi
export JARVIS_NOTCH_DEMO="$(cat "$DEMO_SECRET_FILE")"

say "Starting the brain with the notch switch on"
echo "Data:  $DATA_DIR   (separate from any installed Jarvis)"
echo "Brain: http://localhost:$PORT"
echo "Demo:  in a second terminal, run scripts/notch/demo.sh"
echo "Real:  for real approvals and promises to test on, run scripts/notch/fixture.sh"
if [ "$START" = 1 ] && [ "$TARGET" = "windows" ] && [ -f "$APP_DIR/bin/jarvis.exe" ]; then
  # A desktop app that was never enrolled gets the token that was just made,
  # and asks for nothing. One that is enrolled starts as it always has.
  START_ARGS=""
  if [ "$NEW_APP" = 1 ] && [ -n "$TOKEN" ]; then
    # Started as a double-click would, with its console window: a hidden one
    # could hand its hiddenness on to the desktop app's own first window.
    START_ARGS=" -ArgumentList '--token','$TOKEN'"
    echo "The test build starts by itself once the brain is up, with the token"
    echo "above. Nothing to paste."
  else
    echo "The test build starts by itself once the brain is up. If a window asks"
    echo "for a token, it is the one above."
  fi
  # Start-Process launches the start file the way a double-click would and
  # returns at once, so nothing here waits on the desktop app.
  (
    for _ in $(seq 1 90); do
      if curl -fsS -m 3 -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
        powershell.exe -NoProfile -Command "Start-Process -FilePath '$(wslpath -w "$APP_DIR/start-sidecar.cmd")'$START_ARGS" >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 1
    done
    echo "The brain did not answer in 90 seconds, so the test build was not started. Run $START_HINT by hand." >&2
  ) &
elif [ "$START" = 1 ] && [ "$TARGET" = "mac" ] && [ -d "$APP_DIR/Jarvis.app" ]; then
  # As on Windows: the app is started once the brain answers, with the token that was just made when it
  # was never enrolled. An installed Jarvis has to be quit from the menu bar first.
  echo "The test build starts by itself once the brain is up. Its own log: $APP_DIR/app.log"
  (
    for _ in $(seq 1 90); do
      if curl -fsS -m 3 -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
        if [ "$NEW_APP" = 1 ] && [ -n "$TOKEN" ]; then "$APP_DIR/start-sidecar.command" "$TOKEN" >/dev/null 2>&1 || true
        else "$APP_DIR/start-sidecar.command" >/dev/null 2>&1 </dev/null || true; fi
        exit 0
      fi
      sleep 1
    done
    echo "The brain did not answer in 90 seconds, so the test build was not started. Run $START_HINT by hand." >&2
  ) &
elif [ -n "${START_HINT:-}" ]; then
  echo "Next:  quit Jarvis from its tray or menu-bar icon, then run"
  echo "       $START_HINT"
fi
# Worded so that it is not itself the line it tells of: a script that waits for that line in this output
# would otherwise find it here, before the notch is up.
echo "Ready when a line of the brain says that \"$DEVICE\" shows the notch."
echo
JARVIS_NOTCH=1 exec bun run dev:local --data-dir "$DATA_DIR" --port "$PORT"
