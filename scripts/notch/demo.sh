#!/usr/bin/env bash
# Plays demo moments on the notch of the brain that scripts/notch/try.sh
# started. Run it in a second terminal while that brain is up.
#
#   scripts/notch/demo.sh            a menu: type a number or a name
#   scripts/notch/demo.sh <moment>   play one moment
#   scripts/notch/demo.sh list       name the moments
#   scripts/notch/demo.sh stop       stop the one playing and rest the notch
#
# It is `jarvis notch demo` pointed at the test brain: same port, and the
# secret try.sh made for it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DATA_DIR="${NOTCH_DATA_DIR:-$HOME/.jarvis-notch}"
PORT="${NOTCH_PORT:-3143}"
SECRET_FILE="$DATA_DIR/.notch-demo-secret"

if [ ! -s "$SECRET_FILE" ]; then
  echo "No demo secret at $SECRET_FILE. Start the brain with scripts/notch/try.sh first." >&2
  exit 1
fi
JARVIS_NOTCH_DEMO="$(cat "$SECRET_FILE")"
export JARVIS_NOTCH_DEMO

# The command line reads nothing of an installed Jarvis: it is given the port.
play() { JARVIS_HOME="$DATA_DIR/data" bun bin/jarvis.ts notch demo "$@" --port "$PORT"; }

if [ $# -gt 0 ]; then
  play "$@"
  exit $?
fi

listing="$(play list)" || exit $?
names="$(printf '%s\n' "$listing" | sed -n 's/^Moments: //p' | tr -d ',')"
if [ -z "$names" ]; then
  printf '%s\n' "$listing"
  exit 1
fi
# shellcheck disable=SC2206
moments=($names)

while true; do
  echo
  i=1
  for name in "${moments[@]}"; do
    printf '  %2d  %s\n' "$i" "$name"
    i=$((i + 1))
  done
  echo "   s  stop        q  quit"
  printf 'Play: '
  read -r pick || exit 0
  case "$pick" in
    q|quit|exit) exit 0 ;;
    s|stop) play stop || true ;;
    '') ;;
    *[!0-9]*) play "$pick" || true ;;
    *)
      if [ "$pick" -ge 1 ] && [ "$pick" -le "${#moments[@]}" ]; then
        play "${moments[$((pick - 1))]}" || true
      else
        echo "There is no number $pick."
      fi
      ;;
  esac
done
