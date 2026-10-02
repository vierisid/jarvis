#!/usr/bin/env bash
#
# Prove that CI's Chromium/no-Chromium split of the Go sidecar tests is the
# split the CODE asks for, not a list somebody remembered to update.
#
# test.yml partitions the sidecar module between an un-retried `go test -skip`
# step and a 3-attempt `go test -run` step, because a test that drives a real
# headless Chromium flakes on a loaded runner ("CDP timeout for
# Target.getTargets", a profile dir losing a race with a still-dying Chrome) and
# an infra flake must not read as a code failure.
#
# The partition used to be one test name, `^TestBrowserHandlerParityIntegration$`.
# By the time #639 was filed there were FOUR Chromium-driving tests and three of
# them sat in the un-retried step -- two added by #637 and one that had been
# there all along. Nobody did anything wrong: membership was maintained by hand,
# and a hand-kept list drifts silently every time a test is added. That drift is
# the defect, not the particular names, so this derives membership twice and
# fails unless the two agree:
#
#   from the code   chromium-tests.go walks the AST of the test files the go
#                   tool compiles and returns every top-level test whose body
#                   calls the Chromium launcher probe. See that file for why it
#                   is an AST walk and not a grep -- a grep over these
#                   raw-string-heavy fixtures had a demonstrated silent hole.
#   from the regex  whatever `go test -list <pattern>` returns for the pattern
#                   CI actually passes to BOTH -run and -skip.
#
# Exactly equal and non-empty, or this exits 1 and names the difference in both
# directions. So a new Chromium test cannot quietly land in the wrong step: if
# it does not match the pattern, the derived set is bigger than the listed set
# and CI fails naming the test and the convention it should follow.
#
# Why the launcher probe and not the thing that really opens a browser
# (getCDP/getCDPForParams/launchCDP): those symbols appear in test files that
# deliberately never start one -- browser_read_guard_test.go installs a FAKE
# into the process-global activeCDP, and browser_navigate_guard_test.go and
# browser_fetch_guard_test.go only name them in comments. Deriving from them
# would flag three files that need no retry at all. The probe is the uniform,
# exact marker: all four Chromium tests open with it, and no other test file
# calls it.
#
# The one residual gap, stated so nobody trusts this further than it goes: a
# future test that drives Chromium WITHOUT calling the probe is not derived, so
# it would not be caught. Such a test would also FAIL rather than skip on a
# machine with no Chromium, which is the louder of the two failures.
#
# Usage:  .github/scripts/chromium-test-partition.sh <go-test-regex> [sidecar-dir]
#   e.g.  from sidecar/:  ../.github/scripts/chromium-test-partition.sh "$CHROMIUM_TESTS"
#
# Exit 0 = the two sets agree and are non-empty, and the script prints the set
#          size as `count=<n>` on its last line for a caller that wants it.
# Exit 1 = they disagree, the set is empty, the packages do not build, or a use
#          of the probe cannot be attributed to a test.

set -euo pipefail

PATTERN="${1:-}"
if [ -z "$PATTERN" ]; then
  echo "::error::usage: chromium-test-partition.sh <go-test-regex> [sidecar-dir]" >&2
  exit 1
fi

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SIDECAR_DIR="${2:-${SCRIPT_DIR}/../../sidecar}"
if [ ! -d "$SIDECAR_DIR" ]; then
  echo "::error::no sidecar directory at ${SIDECAR_DIR}" >&2
  exit 1
fi
SIDECAR_DIR="$(CDPATH='' cd -- "$SIDECAR_DIR" && pwd)"

DERIVER="${SCRIPT_DIR}/chromium-tests.go"
if [ ! -f "$DERIVER" ]; then
  echo "::error::missing ${DERIVER}, which derives the Chromium set from the source" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ─── 1. Derive the set from the source ──────────────────────────────
#
# Its stderr is passed through: it reports a probe call it cannot attribute to a
# test (a shared helper, a package-level var) as an error rather than dropping
# it, because under-reporting is exactly what puts a test back in the un-retried
# step.
if ! derived="$(go run "$DERIVER" -dir "$SIDECAR_DIR")"; then
  echo "::error::deriving the Chromium test set from ${SIDECAR_DIR} failed; see above" >&2
  exit 1
fi
printf '%s\n' "$derived" | grep '^Test' | LC_ALL=C sort -u > "${WORK}/derived" || true
derived_count="$(grep -c '^' < "${WORK}/derived" || true)"

# Zero is the vacuous case and a HARD error, not an agreement. Two empty sets
# compare equal, so without this the whole check -- and the retried step it
# guards -- would pass while running nothing. Same failure mode as `go test
# -run` printing "no tests to run" and exiting 0, which is what the guard this
# replaces existed for. In practice this fires when the probe is renamed and the
# derivation goes blind, which set equality alone would not catch.
if [ "$derived_count" -eq 0 ]; then
  echo "::error::no test under ${SIDECAR_DIR} calls the Chromium launcher probe. Either every Chromium test was removed, or the probe was renamed and this check is now blind (see the -probe flag in chromium-tests.go). Refusing to pass vacuously." >&2
  exit 1
fi

echo "derived from the source (${derived_count} test(s) calling the Chromium launcher probe):"
sed 's/^/    /' "${WORK}/derived"

# ─── 2. Derive the set from the regex CI passes ─────────────────────
#
# -list's own failure is captured separately from "matched nothing". A single
# `go test -list ... | grep '^Test'` pipeline under `set -o pipefail` reports
# grep's exit 1 when nothing matches, which would mask "the package does not
# compile" and blame a rename for it. Same reasoning as the X-hotkey guard.
#
# Note `go test -list` is not a static query: it builds and runs each package's
# binary, so package init() and TestMain execute. It is the same code CI runs
# two steps later either way.
#
# ./... rather than the root package, because the -skip step runs ./... too. If
# the two covered different package sets, a Chromium test added in a subpackage
# would be skipped in one step and not run in the other. Set members are bare
# test names with no package attribution, so two identically named Chromium
# tests in different packages collapse to one entry here -- which fails closed
# rather than open: `go test -run` would then emit two `^--- PASS` against an
# expected count of one, and the caller's PASS assertion reds.
if ! listing="$(cd "$SIDECAR_DIR" && go test -list "$PATTERN" ./... 2>&1)"; then
  echo "::error::go test -list failed; the sidecar packages do not build:" >&2
  printf '%s\n' "$listing" >&2
  exit 1
fi
# `go test -list` interleaves per-package "ok"/"?" status lines with the names;
# only a test name starts at column zero with Test.
printf '%s\n' "$listing" | grep '^Test' | LC_ALL=C sort -u > "${WORK}/listed" || true
listed_count="$(grep -c '^' < "${WORK}/listed" || true)"

echo "matched by the CI pattern ${PATTERN} (${listed_count} test(s)):"
sed 's/^/    /' "${WORK}/listed"

# ─── 3. The two must be exactly equal ───────────────────────────────
#
# Set equality, not a count. A count is blind to a swap: add one Chromium test
# and remove another in the same PR and the number still matches.
missing="$(LC_ALL=C comm -23 "${WORK}/derived" "${WORK}/listed")"
extra="$(LC_ALL=C comm -13 "${WORK}/derived" "${WORK}/listed")"

status=0
if [ -n "$missing" ]; then
  echo "::error::these tests drive a real Chromium, but the CI pattern ${PATTERN} does not match them, so they are not in the retried step (#639):" >&2
  printf '%s\n' "$missing" | sed 's/^/    /' >&2
  echo "    Name a Chromium-driving test TestBrowser<Thing>Integration, the reserved shape this pattern matches." >&2
  echo "    If one of these is already named that way, it is excluded on this GOOS by a build constraint -- it then runs in NEITHER step, and the constraint or the pattern has to change." >&2
  status=1
fi
if [ -n "$extra" ]; then
  echo "::error::the CI pattern ${PATTERN} matches these tests, but none of them calls the Chromium launcher probe, so they are retried for a flake class they cannot have AND they do not run in the un-retried step:" >&2
  printf '%s\n' "$extra" | sed 's/^/    /' >&2
  echo "    Rename them out of the TestBrowser...Integration shape, or give them the probe if they really do need Chromium." >&2
  status=1
fi
if [ "$status" -ne 0 ]; then
  exit 1
fi

echo "ok: the ${derived_count} test(s) that drive a real Chromium are exactly the ${listed_count} the retried step runs"
echo "count=${derived_count}"
