#!/usr/bin/env bash
# A fully empty try: a brain with no data at all, and a desktop app that has
# never met it. What a new person sees: the card that says it is installed,
# day one from its first word, no AI, no mail, nothing remembered.
#
#   scripts/notch/fresh.sh           stop what is left of the last empty try,
#                                    wipe its two folders, build, start
#   scripts/notch/fresh.sh --stop    stop the empty try, and nothing else
#   scripts/notch/fresh.sh --check   say what it would do, and do nothing
#
# It uses folders of its own, and wipes only those:
#   brain data    ~/.jarvis-notch-fresh
#   desktop app   JarvisNotchFresh in your user folder (Windows), or in your
#                 home folder (Mac)
# Your usual test data (~/.jarvis-notch) and test build (JarvisNotchDev) are
# not touched, and nothing of theirs is ever stopped from here. Both use the
# same port, so only one can run at a time: stop the usual test brain (Ctrl-C)
# and quit its desktop app from the tray before you run this.
#
# Nothing has to be pasted: the desktop app is started with its token.
# docs/notch/README.md has the rest.
set -euo pipefail

CHECK=0
STOP=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --stop) STOP=1 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PORT="${NOTCH_PORT:-3143}"
DATA="${NOTCH_FRESH_DATA_DIR:-$HOME/.jarvis-notch-fresh}"
USUAL="${NOTCH_DATA_DIR:-$HOME/.jarvis-notch}"
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  APP="${NOTCH_FRESH_APP_DIR:-$HOME/JarvisNotchFresh}"
elif [ "$OS" = "Linux" ] && command -v cmd.exe >/dev/null 2>&1; then
  WIN_HOME="$(wslpath -u "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")"
  APP="${NOTCH_FRESH_APP_DIR:-$WIN_HOME/JarvisNotchFresh}"
else
  echo "This script runs on Windows (from WSL) or macOS." >&2
  exit 1
fi

# Only ever the two fresh folders, and only when they are fresh ones by name:
# a wrong setting must not be able to point this at real data.
case "$(basename "$DATA")" in *jarvis-notch-fresh*) ;; *) echo "Refusing to wipe $DATA: its name does not say it is a fresh folder." >&2; exit 2 ;; esac
case "$(basename "$APP")" in *JarvisNotchFresh*) ;; *) echo "Refusing to wipe $APP: its name does not say it is a fresh folder." >&2; exit 2 ;; esac

# The brain that runs on a data folder, by that folder's own lock file: the
# brain writes its process number there and holds the file while it lives.
# Nothing is printed when no brain runs on it. A brain is known by its folder,
# never by its name.
brain_on() {
  local file="$1/data/jarvis.pid" pid="" rest=""
  [ -f "$file" ] || return 0
  read -r pid rest < "$file" || true
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  # A number left in a stale file may belong to some other program by now.
  ps -p "$pid" -o command= 2>/dev/null | grep -q 'bin/jarvis.ts' || return 0
  # And a brain that lives holds its lock: a file that can be locked is stale.
  if command -v flock >/dev/null 2>&1 && flock -n "$file" true 2>/dev/null; then return 0; fi
  echo "$pid"
}
gone() { ! kill -0 "$1" 2>/dev/null; }

FRESH_BRAIN="$(brain_on "$DATA")"
USUAL_BRAIN="$(brain_on "$USUAL")"

# A brain on the port that is not the fresh one is the usual test brain, or
# another Jarvis: the person's to stop.
if [ -z "$FRESH_BRAIN" ] && [ "$STOP" != 1 ] && curl -fsS -m 3 -o /dev/null "http://localhost:$PORT/health" 2>/dev/null; then
  echo "Another brain is running on port $PORT, and it is not the empty one. Stop it first: Ctrl-C in its terminal." >&2
  if [ -n "$USUAL_BRAIN" ]; then
    echo "It is your usual test brain. If its terminal is gone, this stops it:  kill $USUAL_BRAIN" >&2
  fi
  echo "Nothing was wiped." >&2
  exit 1
fi

# On Windows: which desktop apps are running. One from the fresh folder is a
# fresh build left over from the last try, and is stopped here, by its own
# path. Any other is the usual test build or an installed Jarvis, and is the
# person's to quit: nothing of theirs is stopped from here.
FRESH_UP=0
if [ "$OS" != "Darwin" ]; then
  DIR_W="$(wslpath -m "$APP" | tr '/' '\\')\\"
  DIR_PS="${DIR_W//\'/\'\'}"
  MINE="\$_.Path -and \$_.Path.StartsWith('$DIR_PS', [System.StringComparison]::OrdinalIgnoreCase)"
  COUNTS="$(powershell.exe -NoProfile -Command "\$all = @(Get-Process jarvis -ErrorAction SilentlyContinue); \$mine = @(\$all | Where-Object { $MINE }); Write-Output ([string]\$all.Count + ' ' + [string]\$mine.Count)" 2>/dev/null | tr -d '\r' | tail -n 1)"
  ALL_UP="${COUNTS%% *}"; FRESH_UP="${COUNTS##* }"
  case "$ALL_UP$FRESH_UP" in ''|*[!0-9]*) ALL_UP=0; FRESH_UP=0 ;; esac
  if [ "$ALL_UP" -gt "$FRESH_UP" ] && [ "$STOP" != 1 ]; then
    echo "Jarvis is running on Windows: your usual test build, or an installed one. Quit it from its tray icon, then run this again. Nothing was wiped." >&2
    exit 1
  fi
fi

if [ "$CHECK" = 1 ]; then
  echo "Nothing is in the way. This would:"
  [ -n "$FRESH_BRAIN" ] && echo "  stop the empty brain that is still running (process $FRESH_BRAIN)"
  [ "$FRESH_UP" -gt 0 ] && echo "  stop the fresh build that is still running"
  if [ "$STOP" != 1 ]; then
    echo "  wipe  $DATA"
    echo "  wipe  $APP/profile"
    echo "  build the desktop app into $APP and start both, with nothing to paste"
  fi
  exit 0
fi

# What is left of the last empty try is stopped here, so one command is
# enough. A brain whose terminal was closed has nothing to press Ctrl-C in.
if [ -n "$FRESH_BRAIN" ]; then
  printf '\n== Stopping the empty brain that is still running\n'
  kill -TERM "$FRESH_BRAIN" 2>/dev/null || true
  for _ in $(seq 1 40); do gone "$FRESH_BRAIN" && break; sleep 0.5; done
  if ! gone "$FRESH_BRAIN"; then
    # It was asked and did not go in 20 seconds.
    kill -KILL "$FRESH_BRAIN" 2>/dev/null || true
    for _ in $(seq 1 10); do gone "$FRESH_BRAIN" && break; sleep 0.5; done
  fi
  if ! gone "$FRESH_BRAIN"; then
    echo "The empty brain (process $FRESH_BRAIN) could not be stopped. Nothing was wiped." >&2
    exit 1
  fi
fi
if [ "$FRESH_UP" -gt 0 ]; then
  printf '\n== Stopping the fresh build that is still running\n'
  powershell.exe -NoProfile -Command "Get-Process jarvis -ErrorAction SilentlyContinue | Where-Object { $MINE } | Stop-Process -Force" >/dev/null 2>&1 || true
fi

if [ "$STOP" = 1 ]; then
  if [ -z "$FRESH_BRAIN" ] && [ "$FRESH_UP" = 0 ]; then echo "Nothing of the empty try is running."; else echo "The empty try is stopped. Its data is still there until the next run."; fi
  exit 0
fi

# Stopped is not yet gone from the port.
for _ in $(seq 1 10); do
  curl -fsS -m 2 -o /dev/null "http://localhost:$PORT/health" 2>/dev/null || break
  sleep 0.5
done

printf '\n== Wiping the fresh folders\n'
echo "Brain data:  $DATA"
echo "Desktop app: $APP"
rm -rf "$DATA"
# The desktop app's own settings, its browser and what it kept. The program
# file is built again below. Windows keeps a program's files locked for a
# moment after it has gone, so this is tried for a while.
WIPED=0
for _ in $(seq 1 20); do
  if rm -rf "$APP/profile" 2>/dev/null; then WIPED=1; break; fi
  sleep 1
done
if [ "$WIPED" != 1 ]; then
  echo "Could not empty $APP/profile. The fresh build is probably still running: quit it from its tray icon, then run this again." >&2
  exit 1
fi

if [ "$OS" = "Darwin" ]; then
  NOTCH_DATA_DIR="$DATA" NOTCH_MAC_DIR="$APP" NOTCH_PORT="$PORT" exec scripts/notch/try.sh --token
fi
NOTCH_DATA_DIR="$DATA" NOTCH_WIN_DIR="$APP" NOTCH_PORT="$PORT" exec scripts/notch/try.sh --token
