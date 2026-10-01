#!/usr/bin/env bash
#
# Container smoke check for the JARVIS image.
#
# Builds nothing. Takes an image that is already in the local docker daemon,
# runs it the way a user does -- fresh volume, no config file, default command --
# and asserts the properties a user meets in the first thirty seconds.
#
# This exists because #613 and #614 both shipped in a published image and were
# found by an outside reporter: CI built the image but never ran it, so nothing
# checked what a user actually experiences.
#
#   #614  the HEALTHCHECK fetched the authenticated /api/health, got 401, and the
#         container reported `unhealthy` forever (342 consecutive failures before
#         the reporter looked) while the daemon ran perfectly.
#   #613  the image shipped without prebuilt piece bundles onto a root-owned /app
#         while running as the non-root `jarvis` user, so the workflow engine
#         failed to bootstrap on every clean first run -- and the daemon logged it
#         and carried on, with every other service `running`. A process-liveness
#         check would have passed.
#
# Usage:   .github/scripts/docker-smoke.sh [IMAGE]
#
# Env:
#   SMOKE_PREFIX          name prefix for every resource created
#                         (default: jarvis-smoke-$$; CI passes run_id-run_attempt)
#   SMOKE_HEALTH_TIMEOUT  seconds to wait for `healthy`. Default is DERIVED from
#                         the image's own HEALTHCHECK, see derive_health_timeout.
#   SMOKE_MARKER_TIMEOUT  seconds to wait for the boot markers (default 90)
#   SMOKE_CONTAINER_PORT  port the image serves on inside the container (default 3142)
#
# Exit 0 = every assertion held. Exit 1 = one failed, with diagnostics dumped.

set -euo pipefail

IMAGE="${1:-jarvis:ci}"
PREFIX="${SMOKE_PREFIX:-jarvis-smoke-$$}"
CPORT="${SMOKE_CONTAINER_PORT:-3142}"

# How long to wait for both boot markers to appear. Independent of the health
# timeout: /health is served by the WebSocket server, which binds before the
# daemon finishes booting, so the container can report `healthy` while the tail
# of the boot log is still being written.
MARKER_TIMEOUT="${SMOKE_MARKER_TIMEOUT:-90}"

# Every resource this script creates, so cleanup removes exactly these and
# nothing else. Never prune: CI runners and dev machines are shared.
CREATED_CONTAINERS=()
CREATED_VOLUMES=()
TMPDIR_SMOKE=""

# The container a failure should dump diagnostics for, and the host endpoint of
# the container currently under test. Globals rather than return values: a
# function whose stdout is captured in $(...) cannot usefully call fail(),
# because its exit would only end the subshell and its diagnostics would be
# swallowed into the captured string.
CURRENT_CONTAINER=""
ENDPOINT=""

# The daemon's deliberate-shutdown drain budget defaults to 75s (capped at 85s).
# Docker's default stop grace is 10s, which would SIGKILL it mid-drain -- a torn
# /data going into the very phase meant to detect warm-volume damage.
STOP_GRACE=90

# --- output helpers --------------------------------------------------
#
# Diagnostics go to stderr so they survive even if a caller ever captures a
# function's stdout.

in_actions() { [ -n "${GITHUB_ACTIONS:-}" ]; }
group_open() { if in_actions; then echo "::group::$*" >&2; else echo "--- $* ---" >&2; fi; }
group_close() { if in_actions; then echo "::endgroup::" >&2; else echo "---" >&2; fi; }

step() { echo; echo "==> $*"; }
pass() { echo "    ok: $*"; }

# --- diagnostics -----------------------------------------------------
#
# A red CI job that says only "timed out" costs the next person the same
# investigation the reporter already did. Dump enough to skip that.
#
# Each block is wrapped so that both the command's stdout and its stderr end up
# on this script's stderr: `2>&1 1>&2` inside a group, never the other order.
dump_diagnostics() {
  c="$1"
  if ! docker inspect "$c" >/dev/null 2>&1; then
    echo "(container $c no longer exists)" >&2
    return 0
  fi

  group_open "diagnostics: container state ($c)"
  { docker inspect -f 'Status={{.State.Status}} Running={{.State.Running}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} StartedAt={{.State.StartedAt}} Error={{.State.Error}}' "$c" || true; } 2>&1 1>&2
  group_close

  group_open "diagnostics: health log ($c)"
  # Each probe's exit code and output: the difference between "the probe never
  # ran" and "the probe ran and got a 401".
  if command -v jq >/dev/null 2>&1; then
    { docker inspect -f '{{if .State.Health}}{{json .State.Health}}{{else}}null{{end}}' "$c" 2>/dev/null | jq '.' || true; } 2>&1 1>&2
  else
    { docker inspect -f '{{if .State.Health}}{{json .State.Health}}{{else}}(no health status: image declares no HEALTHCHECK){{end}}' "$c" || true; } 2>&1 1>&2
  fi
  group_close

  group_open "diagnostics: declared healthcheck ($c)"
  { docker inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck}}{{else}}(none){{end}}' "$c" || true; } 2>&1 1>&2
  group_close

  group_open "diagnostics: docker logs ($c, last 200 lines, stdout+stderr)"
  # 2>&1: every failure shape this daemon prints goes to stderr.
  { docker logs --tail 200 "$c" || true; } 2>&1 1>&2
  group_close
}

fail() {
  echo >&2
  echo "FAIL: $*" >&2
  if [ -n "$CURRENT_CONTAINER" ]; then
    dump_diagnostics "$CURRENT_CONTAINER"
  fi
  exit 1
}

# --- cleanup ---------------------------------------------------------
#
# By name, only what this script created, and without disturbing the exit
# status. The image is deliberately NOT removed: the caller supplied it and may
# own it. The workflow removes the tag it built itself.
#
# There is no prune of any kind here, and no filter-based bulk delete.
cleanup() {
  status=$?
  set +e
  # Disarm first so a second signal during cleanup cannot re-enter this
  # function. The cost is that a second Ctrl-C mid-cleanup leaves the rest
  # behind; re-entrant removal would be worse.
  trap - EXIT INT TERM
  echo
  echo "==> cleanup"
  # Explicit length guards rather than a clever empty-array expansion: the
  # quoted `${arr[@]+...}` idiom yields one EMPTY element on an empty array,
  # which would turn into a `docker rm -f ''`.
  if [ "${#CREATED_CONTAINERS[@]}" -gt 0 ]; then
    for c in "${CREATED_CONTAINERS[@]}"; do
      echo "    removing container $c"
      docker rm -f "$c" >/dev/null 2>&1
    done
  fi
  if [ "${#CREATED_VOLUMES[@]}" -gt 0 ]; then
    for v in "${CREATED_VOLUMES[@]}"; do
      echo "    removing volume $v"
      docker volume rm -f "$v" >/dev/null 2>&1
    done
  fi
  [ -n "$TMPDIR_SMOKE" ] && rm -rf "$TMPDIR_SMOKE"
  exit "$status"
}
# INT/TERM as well as EXIT: GitHub cancels a job with SIGINT then SIGTERM, and
# this workflow sets cancel-in-progress for non-main refs.
trap cleanup EXIT INT TERM

# --- lifecycle -------------------------------------------------------

# `docker volume create` is idempotent: given an existing volume it returns 0,
# keeps the contents and says nothing. Adopting one would break this check in
# both directions -- phase A would start on a dirty volume (which is exactly the
# state that can mask a first-boot defect like #613), and cleanup would then
# delete a volume this script did not create. So refuse instead.
create_volume() {
  v="$1"
  if docker volume inspect "$v" >/dev/null 2>&1; then
    fail "volume ${v} already exists. Refusing to adopt it: phase A must start on a volume nothing has ever written to, and cleanup must not remove a volume this script did not create. Remove it by hand or set a different SMOKE_PREFIX."
  fi
  CREATED_VOLUMES+=("$v")   # track before creating: never leak an untracked resource
  docker volume create "$v" >/dev/null || fail "docker volume create ${v} failed"
}

# Start the image the way the #613/#614 reporter did: detached, named volume at
# /data, no config file, no API key, default entrypoint and command.
#
# The host port is ephemeral (`:0:`) rather than a fixed 3142 so this never
# collides with anything else on a shared machine. It is still a published port,
# which is what assertion 4 is about. The mapping changes every time a container
# is created, so it is re-read per phase.
#
# The name is pre-flighted for the same reason as the volume: `docker run` fails
# with 125 on a name conflict and leaves the pre-existing container untouched,
# so registering the name for force-removal before the run would make cleanup
# destroy someone else's container.
run_container() {
  name="$1"; vol="$2"
  if docker inspect "$name" >/dev/null 2>&1; then
    fail "a container named ${name} already exists. Refusing to reuse the name, because cleanup would then force-remove something this script did not create. Remove it by hand or set a different SMOKE_PREFIX."
  fi
  CREATED_CONTAINERS+=("$name")
  docker run -d \
    --name "$name" \
    -p "127.0.0.1:0:${CPORT}" \
    -v "${vol}:/data" \
    "$IMAGE" >/dev/null || fail "docker run failed for container ${name} on image ${IMAGE}"
  CURRENT_CONTAINER="$name"
}

stop_and_remove() {
  name="$1"
  docker stop -t "$STOP_GRACE" "$name" >/dev/null || fail "docker stop failed for ${name}"
  docker rm "$name" >/dev/null || fail "docker rm failed for ${name}"
  # Drop it from the cleanup list; it is already gone. Leaving it there would
  # make cleanup try to remove a name it no longer owns -- harmless today, but
  # the kind of drift that turns into deleting someone else's container once a
  # name is reused.
  remaining=()
  if [ "${#CREATED_CONTAINERS[@]}" -gt 0 ]; then
    for c in "${CREATED_CONTAINERS[@]}"; do
      [ "$c" = "$name" ] || remaining+=("$c")
    done
  fi
  CREATED_CONTAINERS=()
  if [ "${#remaining[@]}" -gt 0 ]; then
    CREATED_CONTAINERS=("${remaining[@]}")
  fi
}

resolve_endpoint() {
  name="$1"
  mapped="$(docker port "$name" "${CPORT}/tcp" 2>/dev/null | head -n1 || true)"
  [ -n "$mapped" ] || fail "container ${name} published no host port for ${CPORT}/tcp"
  # `docker port` prints e.g. "127.0.0.1:32768"; normalise a 0.0.0.0 bind.
  ENDPOINT="${mapped/0.0.0.0/127.0.0.1}"
}

assert_container_running() {
  c="$1"; context="$2"
  running="$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo gone)"
  [ "$running" = "true" ] || fail "container ${c} is not running (state: ${running}) while ${context}"
}

# GET a URL and set HTTP_CODE / HTTP_BODY. curl's own failure is reported as
# rc=<n> rather than concatenated onto the status code, so a connection refusal
# does not render as "HTTP 000000".
http_get() {
  url="$1"
  body_file="${TMPDIR_SMOKE}/body"
  HTTP_CODE="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 10 "$url")" || {
    rc=$?
    HTTP_CODE="curl-error(rc=${rc})"
    HTTP_BODY=""
    return 0
  }
  HTTP_BODY="$(cat "$body_file" 2>/dev/null || true)"
}

# --- how long to wait for `healthy` ----------------------------------
#
# Derived from the image's own HEALTHCHECK rather than hardcoded, so it cannot
# go stale when the Dockerfile's interval or retries change.
#
# Worst case for a probe that never succeeds is StartPeriod + Retries*Interval
# (measured at ~70-100s for the shipped 10s/30s/3 config, depending on how many
# probes land inside the start period and so do not count toward the streak).
# One extra interval of headroom plus 60s of slack covers a loaded runner.
derive_health_timeout() {
  if [ -n "${SMOKE_HEALTH_TIMEOUT:-}" ]; then
    case "$SMOKE_HEALTH_TIMEOUT" in
      ''|*[!0-9]*) fail "SMOKE_HEALTH_TIMEOUT must be a whole number of seconds, got '${SMOKE_HEALTH_TIMEOUT}'" ;;
    esac
    [ "$SMOKE_HEALTH_TIMEOUT" -gt 0 ] || fail "SMOKE_HEALTH_TIMEOUT must be greater than 0"
    HEALTH_TIMEOUT="$SMOKE_HEALTH_TIMEOUT"
    echo "health timeout: ${HEALTH_TIMEOUT}s (from SMOKE_HEALTH_TIMEOUT)"
    return 0
  fi

  # `{{json ...}}`, not a bare `{{...}}`. Interval and StartPeriod are Go
  # time.Duration values, and a bare reference renders them through String() as
  # "30s" / "10s". Those are not integers, so the arithmetic below would
  # silently fall through to the defaults -- which happened to match Interval
  # and did NOT match StartPeriod. `json` prints the raw nanosecond integers.
  hc="$(docker image inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Interval}} {{json .Config.Healthcheck.StartPeriod}} {{json .Config.Healthcheck.Retries}}{{else}}none{{end}}' "$IMAGE" 2>/dev/null || echo none)"
  if [ "$hc" = "none" ]; then
    # No HEALTHCHECK: assertion 1 fails immediately on NO_HEALTHCHECK anyway.
    HEALTH_TIMEOUT=180
    echo "health timeout: ${HEALTH_TIMEOUT}s (image declares no HEALTHCHECK)"
    return 0
  fi

  interval_ns="$(printf '%s' "$hc" | cut -d' ' -f1)"
  start_ns="$(printf '%s' "$hc" | cut -d' ' -f2)"
  retries="$(printf '%s' "$hc" | cut -d' ' -f3)"

  # Validate explicitly rather than letting a non-numeric value fall through to
  # a default that merely looks plausible. A wrong-but-plausible timeout is how
  # this check would quietly stop failing fast.
  case "$interval_ns" in ''|*[!0-9]*) fail "could not read the HEALTHCHECK Interval as an integer (got '${interval_ns}' from ${IMAGE})" ;; esac
  case "$start_ns" in ''|*[!0-9]*) fail "could not read the HEALTHCHECK StartPeriod as an integer (got '${start_ns}' from ${IMAGE})" ;; esac
  case "$retries" in ''|*[!0-9]*) fail "could not read the HEALTHCHECK Retries as an integer (got '${retries}' from ${IMAGE})" ;; esac

  # Docker treats a zero Interval/Retries as "use my built-in default". A zero
  # StartPeriod is legitimate and means there is no start period.
  [ "$interval_ns" -gt 0 ] || interval_ns=30000000000
  [ "$retries" -gt 0 ] || retries=3

  interval_s=$(( interval_ns / 1000000000 ))
  start_s=$(( start_ns / 1000000000 ))
  HEALTH_TIMEOUT=$(( start_s + (retries + 1) * interval_s + 60 ))
  echo "health timeout: ${HEALTH_TIMEOUT}s (derived: start_period ${start_s}s + (retries ${retries} + 1) x interval ${interval_s}s + 60s slack)"
}

# --- assertion 1: the container reaches `healthy` --------------------
#
# The one that catches #614 directly. `unhealthy` is terminal for a probe whose
# endpoint never answers, so fail on it the moment it appears rather than
# waiting out the clock.
#
# A missing `.State.Health` is a FAILURE, not a pass: an image with no
# HEALTHCHECK must not satisfy "the container reaches healthy", because a
# `depends_on: condition: service_healthy` consumer would block on it forever.
assert_reaches_healthy() {
  c="$1"; phase="$2"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  polls=0

  step "[${phase} 1/4] waiting for health status 'healthy' (timeout ${HEALTH_TIMEOUT}s)"

  while : ; do
    assert_container_running "$c" "waiting for it to become healthy -- it died instead"

    # The {{if}} guard is what makes an absent healthcheck detectable. A bare
    # {{.State.Health.Status}} does not print a harmless placeholder: on Docker
    # 29 it is a template error and `docker inspect` exits non-zero, which under
    # `set -e` would kill this script with no message and no diagnostics.
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}NO_HEALTHCHECK{{end}}' "$c" 2>/dev/null || echo INSPECT_FAILED)"
    polls=$(( polls + 1 ))

    case "$status" in
      healthy)
        # No extra "a probe really ran" guard here: docker only promotes
        # `starting` -> `healthy` on a probe that executed and exited 0, so the
        # status already carries that proof. A separate check would be one that
        # can never fail.
        pass "reached 'healthy' after ${polls} poll(s)"
        return 0
        ;;
      unhealthy)
        fail "container ${c} reported 'unhealthy' (terminal). This is the #614 shape: the endpoint the HEALTHCHECK probes never answers successfully."
        ;;
      NO_HEALTHCHECK)
        fail "image ${IMAGE} declares no HEALTHCHECK, so it can never report 'healthy'. A consumer using 'depends_on: condition: service_healthy' would block forever."
        ;;
      starting)
        : # the only status that keeps the loop going
        ;;
      *)
        fail "unexpected health status '${status}' for container ${c}"
        ;;
    esac

    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "container ${c} never reached 'healthy' within ${HEALTH_TIMEOUT}s (last status: ${status}, ${polls} polls)"
    fi
    sleep 2
  done
}

# --- assertion 2: the HEALTHCHECK's own endpoint is public -----------
#
# Checked from OUTSIDE the container, against the endpoint the image's own probe
# requests. That is what stops this passing the way the shipped probe "passed":
# #614's check fetched an authenticated route, got 401 and exited 1 forever, and
# a probe rewritten to exit 0 unconditionally satisfies assertion 1 but fails
# here (verified against images built exactly those ways).
#
# Since #618 the probe resolves its port at probe time instead of carrying a
# literal: JARVIS_PORT, then the bound port recorded on line 2 of
# $JARVIS_HOME/jarvis.pid (which wins), then 3142. So "the port the probe uses"
# is no longer a string in the Dockerfile, and asserting string equality against
# a literal is not the equivalence we need any more.
#
# What the guard has to guarantee is unchanged: the socket this check reaches
# over the published host mapping must be the socket the probe reaches inside
# the container. So resolve the port from the SAME source the probe reads, in
# the container, and require it to equal the container port published here. A
# probe pointing anywhere else still fails -- re-proven with an image whose
# probe hardcodes a different port.

# Reconstruct the URL the probe requests, into PROBE_PATH and PROBE_PORT.
#
# PROBE_PORT is left empty when the probe builds it dynamically; the caller
# resolves it from the container in that case.
parse_probe_target() {
  probe_cmd="$1"
  PROBE_PATH=""
  PROBE_PORT=""

  # Isolate the fetch() argument, so quoted strings elsewhere in the probe
  # (JARVIS_HOME's '/data' default, the '/jarvis.pid' filename) cannot be
  # mistaken for the request path.
  fetch_region="$(printf '%s' "$probe_cmd" | grep -oE "fetch\([^)]*\)" | head -n1 || true)"

  # Concatenate the single-quoted string literals inside it, which is how a
  # dynamic URL is assembled: 'http://127.0.0.1:' + port + '/health'. Dropping
  # the non-literal parts leaves "http://127.0.0.1:/health" -- an empty port,
  # which is the signal to resolve it from the container. A fully literal URL
  # ('http://localhost:3142/api/health') survives this unchanged.
  url_template=""
  if [ -n "$fetch_region" ]; then
    url_template="$(printf '%s' "$fetch_region" | grep -oE "'[^']*'" | tr -d "'" | tr -d '\n' || true)"
  fi
  # Fall back to a plain full URL anywhere in the command, which covers a
  # curl/wget style probe with no fetch() call at all.
  case "$url_template" in
    *://*) : ;;
    *) url_template="$(printf '%s' "$probe_cmd" | grep -oE 'https?://[^"'"'"'\\ )]+' | head -n1 || true)" ;;
  esac
  [ -n "$url_template" ] || return 1
  case "$url_template" in *://*) : ;; *) return 1 ;; esac

  rest="${url_template#*://}"
  case "$rest" in
    */*) PROBE_PATH="/${rest#*/}" ;;
    *)   PROBE_PATH="/" ;;
  esac
  authority="${rest%%/*}"
  PROBE_PORT="${authority##*:}"
  if [ "$PROBE_PORT" = "$authority" ]; then
    # No colon at all: an implicit scheme default, not a dynamic port.
    case "$url_template" in
      https://*) PROBE_PORT=443 ;;
      *)         PROBE_PORT=80 ;;
    esac
  fi
  return 0
}

# Mirror the probe's own resolution order, reading the same lock file it reads.
# Sets PROBE_PORT.
resolve_probe_port_from_container() {
  c="$1"
  # Line 2 of the lock file is the port the daemon actually bound
  # (`${pid}\n${port}\n`, src/daemon/pid.ts). The probe takes the second
  # integer group of the file, so take the same one.
  lock_port="$(docker exec "$c" sh -c 'f="${JARVIS_HOME:-/data}/jarvis.pid"; [ -f "$f" ] && cat "$f" || true' 2>/dev/null | grep -oE '[0-9]+' | sed -n '2p' || true)"
  env_port="$(docker exec "$c" sh -c 'printf "%s" "${JARVIS_PORT:-}"' 2>/dev/null || true)"

  # The probe's precedence: the lock file wins, then JARVIS_PORT, then 3142.
  # Each rung is validated the way the probe's vp() validates it.
  PROBE_PORT=""
  PROBE_PORT_SOURCE=""
  for candidate in "lock:${lock_port}" "env:${env_port}" "default:3142"; do
    value="${candidate#*:}"
    case "$value" in ''|*[!0-9]*) continue ;; esac
    [ "$value" -gt 0 ] && [ "$value" -lt 65536 ] || continue
    PROBE_PORT="$value"
    PROBE_PORT_SOURCE="${candidate%%:*}"
    break
  done
  [ -n "$PROBE_PORT" ] || fail "could not resolve the port the HEALTHCHECK probes for ${c}: the lock file, JARVIS_PORT and the 3142 default all failed validation"
}

assert_healthcheck_endpoint_is_public() {
  c="$1"; phase="$2"

  step "[${phase} 2/4] the endpoint the HEALTHCHECK probes answers without credentials"

  # Same {{if}} guard as the health poll: on an image with no HEALTHCHECK a bare
  # reference is a template error and docker exits non-zero. Unreachable today
  # because assertion 1 fails first, mirrored so the two cannot drift.
  #
  # `range` rather than `json` so the command arrives unescaped: the probe's
  # own quoting is what has to be parsed, not JSON's rendering of it.
  probe_cmd="$(docker inspect -f '{{if .Config.Healthcheck}}{{range .Config.Healthcheck.Test}}{{.}} {{end}}{{else}}none{{end}}' "$c" 2>/dev/null || echo none)"
  [ -n "$probe_cmd" ] && [ "$probe_cmd" != "none" ] && [ "$probe_cmd" != "none " ] \
    || fail "container ${c} has no HEALTHCHECK test to inspect"

  parse_probe_target "$probe_cmd" \
    || fail "could not work out which URL the HEALTHCHECK requests, so its endpoint cannot be verified from outside. Probe: ${probe_cmd}"

  [ -n "$PROBE_PATH" ] || fail "extracted an empty request path from the HEALTHCHECK. Probe: ${probe_cmd}"
  case "$PROBE_PATH" in /*) : ;; *) fail "extracted a request path that is not absolute ('${PROBE_PATH}') from the HEALTHCHECK. Probe: ${probe_cmd}" ;; esac

  if [ -z "$PROBE_PORT" ]; then
    resolve_probe_port_from_container "$c"
    echo "    healthcheck resolves its port at probe time; resolved to ${PROBE_PORT} from the ${PROBE_PORT_SOURCE}"
  else
    case "$PROBE_PORT" in ''|*[!0-9]*) fail "extracted a non-numeric port ('${PROBE_PORT}') from the HEALTHCHECK. Probe: ${probe_cmd}" ;; esac
    echo "    healthcheck probes port ${PROBE_PORT} literally"
  fi

  # The guard. If the probe reaches a different socket than the one published
  # here, then hitting the published mapping would prove nothing about the
  # probe's endpoint.
  [ "$PROBE_PORT" = "$CPORT" ] \
    || fail "the HEALTHCHECK probes port ${PROBE_PORT} but this check published container port ${CPORT}; refusing to assert against a different endpoint than the probe uses"

  echo "    asserting from host: http://${ENDPOINT}${PROBE_PATH}"

  # No cookie, no token, no header: exactly what the in-container probe has.
  http_get "http://${ENDPOINT}${PROBE_PATH}"
  [ "$HTTP_CODE" = "200" ] || fail "the endpoint the HEALTHCHECK probes (${PROBE_PATH}) returned HTTP ${HTTP_CODE} without credentials, so the probe can never succeed. This is the #614 shape -- 401 means the route requires an enrolled device token."
  pass "${PROBE_PATH} returned HTTP 200 unauthenticated"
}

# --- assertion 3: no service reports a startup failure ---------------
#
# #613's daemon started fine, logged `Workflow engine failed to start` and
# carried on with every other service `running` in its own boot summary. Both a
# process-liveness check and that summary would have passed. This assertion is
# the one that catches that class.
#
# Patterns are ASCII-only on purpose: the real #613 message contains an em dash
# (U+2014) and the boot summary uses tick/cross glyphs. Anchoring on those would
# make the grep silently stop matching.
#
# Deliberately NOT included: `Unhealthy services detected` (src/daemon/health.ts).
# HealthMonitor runs on a 30s setInterval, so its first report lands after this
# check has finished a phase -- the pattern could never match, which is the
# "grep that matches nothing" shape this check exists to avoid. Nothing is lost:
# any service that reaches `error` also logs the `Failed to start` shape that the
# first pattern catches.
FAILURE_PATTERNS=(
  'failed to start'                   # [Daemon] Workflow engine failed to start / [ServiceRegistry] Failed to start X
  'workflow-engine bootstrap phase'   # phase-agnostic: bundle-build | piece-compile | sandbox-api-start
  'install tree is read-only'         # the #613 root cause
  'Workflow worker not started'       # the downstream consequence of #613, logged separately
  'Fatal error during startup'        # the daemon's catch-all boot failure
  'Uncaught exception'                # process-level; reachable via the end-of-phase rescan
  'Unhandled rejection'               # process-level; reachable via the end-of-phase rescan
)

# A boot is only "clean" if it actually completed. Requiring these makes
# assertion 3 impossible to satisfy vacuously: an empty, truncated or
# still-being-written log fails here instead of quietly reporting "no failures".
#
# `JARVIS daemon running on port` is not literally the final line of
# startDaemon (`Press Ctrl+C to stop` and the health summary follow it), but it
# is emitted after every service has been started, which is what makes it a
# sufficient "the boot got all the way through" marker.
REQUIRED_MARKERS=(
  'JARVIS daemon running on port'          # emitted once every service has started
  'Health endpoint: http://localhost:'     # the WebSocket server bound its TCP port
)

# Scan a captured log for every failure shape. Shared by the boot-time scan and
# the end-of-phase rescan.
scan_log_for_failures() {
  logfile="$1"; phase="$2"; when="$3"
  for pat in "${FAILURE_PATTERNS[@]}"; do
    # grep -i: the shapes differ in case ("Failed to start" vs "failed to start").
    set +e
    hits="$(grep -iF -- "$pat" "$logfile")"
    rc=$?
    set -e
    # rc 0 = matched, 1 = no match, 2 = grep could not read the file. Treating
    # rc 2 as "no match" would let an unreadable log pass as clean.
    [ "$rc" -le 1 ] || fail "grep failed (rc=${rc}) reading ${logfile}; cannot prove the log is clean"
    if [ "$rc" -eq 0 ]; then
      echo "    matched failure pattern '${pat}':" >&2
      printf '%s\n' "$hits" | sed 's/^/      /' >&2
      fail "a service reported a startup failure during ${phase} (${when}). The daemon may well still be running and answering -- #613 logged exactly this and carried on."
    fi
  done
}

assert_no_startup_failures() {
  c="$1"; phase="$2"
  logfile="${TMPDIR_SMOKE}/logs"

  step "[${phase} 3/4] no startup failure in the logs"

  # Wait for the boot markers rather than reading once. /health is served by the
  # WebSocket server, which binds before the daemon finishes booting, so the
  # container can be `healthy` while the tail of the boot log is still being
  # written. Reading once here would be a false red on a slow runner.
  marker_deadline=$(( $(date +%s) + MARKER_TIMEOUT ))
  while : ; do
    assert_container_running "$c" "waiting for its boot markers"

    # Order matters: >file then 2>&1. The reverse sends stderr to the real
    # stdout and only stdout to the file, which would drop every failure line,
    # since the daemon prints all of them to stderr.
    docker logs "$c" >"$logfile" 2>&1 || fail "docker logs failed for ${c}"

    missing=""
    for pat in "${REQUIRED_MARKERS[@]}"; do
      grep -qF -- "$pat" "$logfile" || missing="${missing:+${missing}, }${pat}"
    done
    [ -n "$missing" ] || break

    if [ "$(date +%s)" -ge "$marker_deadline" ]; then
      fail "expected boot marker(s) not found within ${MARKER_TIMEOUT}s: ${missing}. The daemon never reported a completed boot, so 'no failures logged' would prove nothing."
    fi
    sleep 2
  done

  lines="$(grep -c '' "$logfile" || true)"
  pass "both boot markers present after ${lines} log line(s) (this is a real, completed boot)"

  scan_log_for_failures "$logfile" "$phase" "boot"
  pass "none of the ${#FAILURE_PATTERNS[@]} failure patterns matched"
}

# Re-read the log at the end of a phase. The boot-time scan above runs as soon
# as the markers appear, so anything logged after that -- an uncaught exception,
# an unhandled rejection, a service falling over while the endpoint assertions
# ran -- would otherwise never be looked at.
assert_phase_end_log_clean() {
  c="$1"; phase="$2"
  logfile="${TMPDIR_SMOKE}/logs-end"

  step "[${phase} 3b/4] still no failure logged at the end of the phase"
  assert_container_running "$c" "checking its log at the end of the phase"
  docker logs "$c" >"$logfile" 2>&1 || fail "docker logs failed for ${c}"

  # The markers were already proven present; re-asserting one keeps this scan
  # from running against an empty file if `docker logs` ever returns nothing.
  grep -qF -- "${REQUIRED_MARKERS[0]}" "$logfile" \
    || fail "the boot marker '${REQUIRED_MARKERS[0]}' is no longer in ${c}'s log; refusing to scan a log this check cannot account for"

  scan_log_for_failures "$logfile" "$phase" "end of phase"
  lines="$(grep -c '' "$logfile" || true)"
  pass "log clean at ${lines} line(s)"
}

# --- assertion 4: the daemon answers on its published port -----------
#
# What a `depends_on: condition: service_healthy` consumer actually needs: the
# public health route reachable from the host. Distinct from assertion 2, which
# targets whatever URL the HEALTHCHECK declares. When those diverge -- as they
# did in #614 -- this one passes while assertion 2 fails, and the two failures
# mean different things.
#
# Since #618 the probe also requests /health, so the two assertions happen to
# hit the same path today. They are still not redundant: this one is pinned to
# the route the daemon documents as public, assertion 2 follows the probe
# wherever it points. Collapsing them would mean a probe moved back to an
# authenticated route had nothing checking it.
assert_public_port_answers() {
  c="$1"; phase="$2"

  step "[${phase} 4/4] the daemon answers /health on its published host port"

  # Re-resolve rather than trusting whatever ENDPOINT happens to hold: a future
  # reorder of run_assertions would otherwise silently test the previous
  # container's mapping.
  resolve_endpoint "$c"
  [ -n "$ENDPOINT" ] || fail "no host endpoint resolved for ${c}"

  http_get "http://${ENDPOINT}/health"
  [ "$HTTP_CODE" = "200" ] || fail "GET http://${ENDPOINT}/health returned HTTP ${HTTP_CODE} from the host (expected 200)"
  [ -n "$HTTP_BODY" ] || fail "GET /health returned 200 with an empty body; refusing to treat that as a healthy daemon"
  # Tolerant of whitespace so this does not break the day /health pretty-prints.
  printf '%s' "$HTTP_BODY" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"' \
    || fail "GET /health returned 200 but the body does not report status ok: ${HTTP_BODY}"
  pass "/health -> 200 and the body reports status ok"
  echo "    body: ${HTTP_BODY}"
}

# --- one full pass over a running container --------------------------

run_assertions() {
  c="$1"; phase="$2"
  CURRENT_CONTAINER="$c"
  resolve_endpoint "$c"
  echo "    container=${c} host=${ENDPOINT}"

  assert_reaches_healthy "$c" "$phase"
  assert_healthcheck_endpoint_is_public "$c" "$phase"
  assert_no_startup_failures "$c" "$phase"
  assert_public_port_answers "$c" "$phase"
  assert_phase_end_log_clean "$c" "$phase"
}

# --- run -------------------------------------------------------------

TMPDIR_SMOKE="$(mktemp -d)"

echo "image:          ${IMAGE}"
echo "name prefix:    ${PREFIX}"

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fail "image ${IMAGE} is not in the local docker daemon. A buildx build needs 'load: true' to put it there."

derive_health_timeout

# Phase A -- cold boot on a fresh volume. A user's very first run, and the state
# both #613 and #614 were reported in.
group_open "phase A: first run, fresh volume"
create_volume "${PREFIX}-vol-a"
run_container "${PREFIX}-a" "${PREFIX}-vol-a"
run_assertions "${PREFIX}-a" "A"
group_close

# Phase B -- a NEW container on the volume phase A just wrote. This is the half
# a fresh-volume-only check cannot see: a defect that only appears once /data
# has content (a bad migration, a stale cache, a file written with the wrong
# owner) is invisible to phase A and phase C.
#
# A new container rather than `docker restart` on purpose. `restart` reuses the
# container's writable layer, so anything first boot wrote *there* is still
# present -- which is exactly how a fix that builds piece bundles into the
# container layer at first boot would hide its own rebuild path. Remove and
# re-run is also what `docker compose pull && up -d` and every image upgrade do,
# so it is the path users actually take. It additionally gives phase B a fresh,
# empty log, so there is no slicing of phase A's output and no chance of
# attributing phase A's shutdown lines to phase B's boot.
group_open "phase B: second run, new container, on the volume phase A wrote"
# Without this, a future image that keeps its state somewhere other than /data
# would turn phase B into a second cold boot -- still green, but with the
# warm-volume coverage silently gone.
docker exec "${PREFIX}-a" sh -c '[ -n "$(ls -A /data 2>/dev/null)" ]' \
  || fail "phase A left /data empty, so phase B would be a second cold boot rather than a run over a written volume. This check's warm-volume coverage would be gone."
echo "    phase A wrote to /data; stopping ${PREFIX}-a with a ${STOP_GRACE}s grace, then re-running on ${PREFIX}-vol-a"
stop_and_remove "${PREFIX}-a"
run_container "${PREFIX}-b" "${PREFIX}-vol-a"
run_assertions "${PREFIX}-b" "B"
group_close

# Phase C -- a second, fully independent clean run. Proves cold boot is
# repeatable rather than something that happened to work once, on a volume
# nothing has ever written to.
group_open "phase C: second clean run, second fresh volume"
create_volume "${PREFIX}-vol-c"
run_container "${PREFIX}-c" "${PREFIX}-vol-c"
run_assertions "${PREFIX}-c" "C"
group_close

CURRENT_CONTAINER=""
echo
echo "PASS: all assertions held on a cold boot, on a second run over the written volume, and on a second clean run."
