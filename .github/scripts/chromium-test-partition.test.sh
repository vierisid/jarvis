#!/usr/bin/env bash
# Tests for chromium-test-partition.sh -- no Chromium and no sidecar required.
#
# The partition guard keeps a Chromium-driving Go test out of CI's un-retried
# step (#639). An edit that neuters it -- widening the test-name rule, an
# `|| true` on the `go run`, dropping the non-empty assertion, going back to a
# line scan -- would still pass CI, because the real sidecar agrees with the
# pattern either way. That is the defect the guard exists to catch, one level
# up (#648).
#
# Each fixture is a throwaway Go module, and every case asserts the exit code
# AND a line that only the intended check prints. Exit code alone is not
# enough: an empty derived set exits 1 too, so a fixture with no real Chromium
# test in it would "fail correctly" no matter which check was broken. That is
# why every failing fixture below also carries one well-formed Chromium test.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/chromium-test-partition.sh"

# The pattern CI passes. In CI this runs inside the sidecar-build job, whose env
# sets CHROMIUM_TESTS, so these cases exercise the real pattern rather than a
# copy of it.
PATTERN="${CHROMIUM_TESTS:-^TestBrowser.*Integration\$}"

# A go.work above the temp dir would pull the fixtures into someone else's
# workspace.
export GOWORK=off

pass=0
fail=0
ok() {
	pass=$((pass + 1))
	echo "  ok   - $1"
}
no() {
	fail=$((fail + 1))
	echo "  FAIL - $1"
	[ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/         /'
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A stub with the real probe's shape. The deriver matches the call by name, so
# what it returns does not matter.
PROBE='func findChromiumExecutable(cfg any) (string, error) { return "", nil }'

# The one well-formed Chromium test every fixture starts from.
GOOD='func TestBrowserAIntegration(t *testing.T) { findChromiumExecutable(nil) }'

# fixture <name> <go source appended to the test file>
fixture() {
	local dir="${WORK}/$1"
	mkdir -p "$dir"
	printf 'module fixture\n\ngo 1.21\n' >"${dir}/go.mod"
	printf 'package fixture\n\nimport "testing"\n\nvar _ = testing.Short\n\n%s\n\n%s\n' \
		"$PROBE" "$2" >"${dir}/fixture_test.go"
}

# expect <description> <fixture> <exit code> <fixed string the output must contain>
expect() {
	local out rc
	out="$("$SCRIPT" "$PATTERN" "${WORK}/$2" 2>&1)"
	rc=$?
	if [ "$rc" -ne "$3" ]; then
		no "$1: exited $rc, want $3" "$out"
	elif ! grep -qF -- "$4" <<<"$out"; then
		no "$1: output does not contain '$4'" "$out"
	else
		ok "$1"
	fi
}

echo "chromium-test-partition.sh (pattern ${PATTERN}):"

fixture agree "$GOOD"
expect "a correctly named Chromium test agrees with the pattern" agree 0 "count=1"

fixture empty 'func TestPlain(t *testing.T) {}'
expect "an empty derived set is refused, not treated as agreement" \
	empty 1 "Refusing to pass vacuously"

fixture misnamed "$GOOD
func TestChromiumOffConvention(t *testing.T) { findChromiumExecutable(nil) }"
expect "a Chromium test named outside the convention is named as missing" \
	misnamed 1 "TestChromiumOffConvention"

fixture extra "$GOOD
func TestBrowserNoChromeIntegration(t *testing.T) {}"
expect "a pattern match that never calls the probe is named as extra" \
	extra 1 "TestBrowserNoChromeIntegration"

# The deriver exits 1 here, so its failure has to reach the script's own error.
# With `|| true` on the `go run` the derived set comes back empty instead, and
# only the vacuous-set message is printed.
fixture helper "$GOOD
func launch() { findChromiumExecutable(nil) }"
expect "a probe call in a helper fails the derivation" \
	helper 1 "::error::deriving the Chromium test set"

# Go's test-name rule: Test followed by a lowercase letter is an ordinary
# function. Read as a test, Testable would be derived and reported as missing
# from the pattern instead of as an unattributed call.
fixture testable "$GOOD
func Testable() { findChromiumExecutable(nil) }"
expect "Testable is not a test name, so its probe call is unattributed" \
	testable 1 "cannot be attributed"

# The #639 hole. A raw string puts a column-zero func line for a test that is
# already in the set above a probe call in a misnamed Chromium test. A line scan
# credits the call to TestBrowserAIntegration, both sets come out as {that one
# test}, and the guard passes while TestUnretried runs un-retried.
fixture rawstring "$GOOD
func TestUnretried(t *testing.T) {
	_ = \`
func TestBrowserAIntegration(t *testing.T) {
\`
	findChromiumExecutable(nil)
}"
expect "a func line inside a raw string does not reattribute a probe call" \
	rawstring 1 "TestUnretried"

# The file set is what the go tool compiles. A Chromium test excluded by a build
# constraint can never come back from `go test -list` on this GOOS, so deriving
# it would be a red nobody could fix.
fixture constrained "$GOOD"
printf '//go:build never\n\npackage fixture\n\nimport "testing"\n\n%s\n' \
	'func TestBrowserBIntegration(t *testing.T) { findChromiumExecutable(nil) }' \
	>"${WORK}/constrained/never_test.go"
expect "a Chromium test excluded by a build constraint is not derived" \
	constrained 0 "count=1"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
