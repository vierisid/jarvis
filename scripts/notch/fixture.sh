#!/usr/bin/env bash
# Makes real things for the notch to be tried on, in the brain that
# scripts/notch/try.sh started. Run it in a second terminal while that brain
# is up. Unlike demo.sh, nothing here is a sample sentence: each is a real
# record, answered through the product's own code (src/notch/fixtures.ts says
# what each one does, and that it is harmless).
#
#   scripts/notch/fixture.sh                 a menu
#   scripts/notch/fixture.sh approval        an approval a key may answer
#   scripts/notch/fixture.sh approval 3      three of them
#   scripts/notch/fixture.sh payment         an approval that is a payment (no money moves)
#   scripts/notch/fixture.sh promise [secs]  a promise due in two minutes, or in [secs]
#   scripts/notch/fixture.sh failure         one failure in the list of open failures
#   scripts/notch/fixture.sh elsewhere       approve the oldest fixture approval as a dashboard click would
#   scripts/notch/fixture.sh log             the lines the promises wrote when they ran
#
# It is `jarvis notch fixture` pointed at the test brain: same port, and the
# secret try.sh made for it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DATA_DIR="${NOTCH_DATA_DIR:-$HOME/.jarvis-notch}"
PORT="${NOTCH_PORT:-3143}"
SECRET_FILE="$DATA_DIR/.notch-demo-secret"
LOG_FILE="$DATA_DIR/data/notch-fixture.log"

if [ ! -s "$SECRET_FILE" ]; then
  echo "No demo secret at $SECRET_FILE. Start the brain with scripts/notch/try.sh first." >&2
  exit 1
fi
JARVIS_NOTCH_DEMO="$(cat "$SECRET_FILE")"
export JARVIS_NOTCH_DEMO

# The command line reads nothing of an installed Jarvis: it is given the port.
make() { JARVIS_HOME="$DATA_DIR/data" bun bin/jarvis.ts notch fixture "$@" --port "$PORT"; }

show_log() {
  if [ -s "$LOG_FILE" ]; then
    echo "$(wc -l < "$LOG_FILE" | tr -d ' ') line(s) in $LOG_FILE, one per promise that ran:"
    cat "$LOG_FILE"
  else
    echo "No promise has run yet: $LOG_FILE is empty or not there."
  fi
}

one() {
  local kind="${1:-}" arg="${2:-}"
  case "$kind" in
    log) show_log ;;
    promise)
      if [ -n "$arg" ]; then make promise --in "$arg"; else make promise; fi
      ;;
    approval)
      local n="${arg:-1}"
      case "$n" in ''|*[!0-9]*) echo "How many must be a number." >&2; return 2 ;; esac
      for _ in $(seq 1 "$n"); do make approval; done
      ;;
    *) make "$kind" ;;
  esac
}

if [ $# -gt 0 ]; then
  one "$@"
  exit $?
fi

while true; do
  echo
  echo "   1  approval          an approval a key may answer"
  echo "   2  approval x3       three of them, for the count and the round"
  echo "   3  payment           an approval that is a payment (no money moves)"
  echo "   4  promise           a promise due in two minutes"
  echo "   5  promise in 20 s   a promise due in twenty seconds"
  echo "   6  failure           one failure in the list of open failures"
  echo "   7  elsewhere         approve the oldest fixture approval as a dashboard click would"
  echo "   l  log               the lines the promises wrote when they ran"
  echo "   q  quit"
  printf 'Make: '
  read -r pick || exit 0
  case "$pick" in
    q|quit|exit) exit 0 ;;
    1) one approval || true ;;
    2) one approval 3 || true ;;
    3) one payment || true ;;
    4) one promise || true ;;
    5) one promise 20 || true ;;
    6) one failure || true ;;
    7) one elsewhere || true ;;
    l|log) show_log ;;
    '') ;;
    *) # shellcheck disable=SC2086
       one $pick || true ;;
  esac
done
