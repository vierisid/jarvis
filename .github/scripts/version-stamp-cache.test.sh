#!/usr/bin/env bash
# Tests for version-stamp-cache.sh -- no Docker required.
#
# That guard asserts a release reuses the image cache (#647). It judges two real
# builds, so a full end-to-end self-test would cost two more image builds per
# run, which is not worth it. What IS worth testing is the property the guard
# lost for four PR branches in a row (#691, #713, #716, #728) and the edits that
# would silently neuter it (#688):
#
#   - CACHE ISOLATION. Both builds must run on a builder the script creates and
#     removes. On a shared builder the warm build is served from gha-imported
#     entries that were never materialised locally, the bump build computes its
#     own, BuildKit cannot match them, and the guard reds a correct branch. That
#     is the bug this file exists to stop coming back.
#   - FAIL-CLOSED CHECKS. The guard's value is that it exits 1 when it cannot
#     recognise what it is judging. Deleting any of those checks leaves a script
#     that passes everything -- and passes CI, because the Dockerfile agrees
#     with it either way. Same shape as #648's argument for the partition guard.
#
# These are source assertions, not behaviour: this file cannot prove the guard
# judges a real build correctly, and does not claim to. It proves the guard has
# not been quietly disarmed. The behavioural half is the guard's own run in CI.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/version-stamp-cache.sh"

fails=0
ok() { printf '  ok   - %s\n' "$1"; }
no() {
  printf '  FAIL - %s\n' "$1" >&2
  fails=$((fails + 1))
}

if [ ! -f "$SCRIPT" ]; then
  echo "version-stamp-cache.sh not found at ${SCRIPT}" >&2
  exit 1
fi

# `bash -n` here as well as in the hook: a syntax error in the guard makes the
# docker-build job fail with no useful message, and this file names it instead.
if bash -n "$SCRIPT" 2>/dev/null; then
  ok "the guard parses"
else
  no "the guard does not parse (bash -n)"
fi

# ─── Cache isolation ───────────────────────────────────────────────

if grep -qE 'docker buildx create --name "\$BUILDER"' "$SCRIPT"; then
  ok "creates its own builder"
else
  no "does not create its own builder: the warm build would be served from the job's gha cache (#688)"
fi

# Every build must name that builder. A second invocation added later without
# --builder is exactly how this regresses, and it would pass CI on main.
builds=$(grep -cE 'docker buildx build' "$SCRIPT")
with_builder=$(grep -cE 'docker buildx build --builder "\$BUILDER"' "$SCRIPT")
if [ "$builds" -gt 0 ] && [ "$builds" -eq "$with_builder" ]; then
  ok "all ${builds} build invocation(s) use that builder"
else
  no "only ${with_builder} of ${builds} 'docker buildx build' invocations pass --builder"
fi

if grep -qE 'docker buildx rm --force "\$BUILDER"' "$SCRIPT"; then
  ok "removes the builder"
else
  no "does not remove the builder: a runner would accumulate buildkit containers"
fi

# Removal has to be on the EXIT trap, not a trailing line: the guard exits 1
# from several places, and each one would otherwise leak a builder.
if grep -qE '^trap cleanup EXIT' "$SCRIPT" &&
  awk '/^cleanup\(\) \{/,/^\}/' "$SCRIPT" | grep -q 'docker buildx rm'; then
  ok "removal runs from the EXIT trap, so an early exit cannot leak it"
else
  no "builder removal is not in the EXIT trap"
fi

# ─── Fail-closed checks ────────────────────────────────────────────
#
# Each entry is the message the guard prints when it cannot recognise what it
# is judging. Matching the message, not the condition, keeps this readable when
# the condition is refactored -- and the message is what an operator sees.
while IFS='|' read -r what msg; do
  [ -n "$what" ] || continue
  if grep -qF "$msg" "$SCRIPT"; then
    ok "fails closed: ${what}"
  else
    no "lost its fail-closed check for ${what} (looked for: ${msg})"
  fi
done <<'CHECKS'
an unrecognised stamp step|no stamp step found
a parser that matched no stages|could not find the steps to judge
a missing production split point|no production 'COPY --from=build /app/package.json' step found
a stamp that did not run, proving nothing|this check proved nothing
a build that did not build|the image did not build with VERSION=
a builder it could not create|could not create a dedicated buildx builder
CHECKS

# The guard must still report a re-run step as a failure. An edit that turned
# this into a warning would leave every check above intact.
if grep -qE 're-ran steps that should be cache hits' "$SCRIPT" &&
  awk '/re-ran steps that should be cache hits/,/^fi/' "$SCRIPT" | grep -qE '^ *exit 1'; then
  ok "a re-run step exits 1 rather than warning"
else
  no "a re-run step no longer exits 1"
fi

# `set -e` with no `|| true` on the builds: a swallowed build failure would make
# the parser judge a stale log from the previous build.
if grep -qE '^set -euo pipefail' "$SCRIPT"; then
  ok "runs under set -euo pipefail"
else
  no "no longer runs under set -euo pipefail"
fi

# ─── The stages it judges ──────────────────────────────────────────
#
# Widening this list is the one edit that makes the guard pass a genuinely
# broken Dockerfile, because an unjudged stage is an allowed stage.
if grep -qE '\(manifest\|deps\|build\|workflows\|production\)' "$SCRIPT"; then
  ok "judges exactly the manifest, deps, build, workflows and production stages"
else
  no "the judged-stage list changed: an unjudged stage is an allowed stage, so confirm that is intended"
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "${fails} failed" >&2
  exit 1
fi
echo "all checks passed"
