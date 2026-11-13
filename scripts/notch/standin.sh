#!/usr/bin/env bash
# The stand-in model, for a test brain that has no model key
# (src/llm/scripted.ts, src/notch/script.ts). It answers from a script written
# in advance: nothing thinks. Run it in a second terminal while the brain that
# scripts/notch/try.sh started is up.
#
#   scripts/notch/standin.sh load [file]   load a script (scripts/notch/standin.json when none is named)
#   scripts/notch/standin.sh type "words"  send words as if typed on the notch
#   scripts/notch/standin.sh say "words"   send words as if spoken (after the microphone)
#   scripts/notch/standin.sh say           a recording in which nothing was caught
#   scripts/notch/standin.sh list          the script, and the calls the stand-in received
#   scripts/notch/standin.sh clear         unload the script
#
# It works only on a brain with no real model. Once a model key is set up the
# brain refuses all of this: then you type and speak on the notch itself.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DATA_DIR="${NOTCH_DATA_DIR:-$HOME/.jarvis-notch}"
PORT="${NOTCH_PORT:-3143}"
SECRET_FILE="$DATA_DIR/.notch-demo-secret"

if [ ! -s "$SECRET_FILE" ]; then
  echo "No demo secret at $SECRET_FILE. Start the brain with scripts/notch/try.sh first." >&2
  exit 1
fi

post() {
  local status
  status="$(curl -sS -o /tmp/notch-standin.$$ -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/notch/script" \
    -H "x-notch-demo-token: $(cat "$SECRET_FILE")" -H 'content-type: application/json' --data-binary @- || true)"
  cat /tmp/notch-standin.$$ 2>/dev/null || true
  echo
  rm -f /tmp/notch-standin.$$
  case "$status" in
    200) ;;
    404) echo "The brain has no such route: it is not running on port $PORT, or not started by try.sh." >&2; return 1 ;;
    *) return 1 ;;
  esac
}

words() { bun -e 'process.stdout.write(JSON.stringify({ op: process.argv[1], text: process.argv[2] ?? "" }))' "$1" "${2:-}"; }

case "${1:-}" in
  load)
    file="${2:-scripts/notch/standin.json}"
    [ -r "$file" ] || { echo "Cannot read $file" >&2; exit 1; }
    bun -e 'const fs = require("fs"); process.stdout.write(JSON.stringify({ op: "set", turns: JSON.parse(fs.readFileSync(process.argv[1], "utf8")) }))' "$file" | post
    ;;
  type) [ -n "${2:-}" ] || { echo 'Type what? scripts/notch/standin.sh type "what is two plus two"' >&2; exit 2; }; words type "$2" | post ;;
  say) words say "${2:-}" | post ;;
  list) echo '{"op":"list"}' | post ;;
  clear) echo '{"op":"clear"}' | post ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
