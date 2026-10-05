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
# Each fixture is a throwaway Go module. Two things keep a case from passing for
# the wrong reason:
#
#   - Every failing fixture also carries one well-formed Chromium test. An
#     empty derived set exits 1 too, so without it a fixture would "fail
#     correctly" no matter which check was broken.
#   - A failing case asserts on STDERR only, and names the error header as well
#     as the test. The guard prints both sets on stdout whatever happens, so a
#     test name found there proves nothing: a guard that compared counts, or
#     reported a missing test under the "extra" advice, would still show it.
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

WORK="$(mktemp -d)" || exit 1
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

# run <fixture>: sets out (stdout), err (stderr) and rc.
run() {
	out="$("$SCRIPT" "$PATTERN" "${WORK}/$1" 2>"${WORK}/stderr")"
	rc=$?
	err="$(cat "${WORK}/stderr")"
}

# expect_agree <description> <fixture> <count>: exit 0, last line exactly count=<n>.
expect_agree() {
	run "$2"
	if [ "$rc" -ne 0 ]; then
		no "$1: exited $rc, want 0" "$out"$'\n'"$err"
	elif [ "$(printf '%s\n' "$out" | tail -n 1)" != "count=$3" ]; then
		no "$1: last line is not count=$3" "$out"
	else
		ok "$1"
	fi
}

# expect_refused <description> <fixture> <fixed string>...: exit 1, and every
# string appears on stderr.
expect_refused() {
	local desc="$1" needle
	run "$2"
	shift 2
	if [ "$rc" -ne 1 ]; then
		no "${desc}: exited $rc, want 1" "$out"$'\n'"$err"
		return
	fi
	for needle in "$@"; do
		if ! grep -qF -- "$needle" <<<"$err"; then
			no "${desc}: stderr does not contain '${needle}'" "$err"
			return
		fi
	done
	ok "$desc"
}

# The guard's two mismatch headers, and the indent it lists names under.
MISSING="the CI pattern ${PATTERN} does not match them"
EXTRA="the CI pattern ${PATTERN} matches these tests, but none of them calls"
I='    '

echo "chromium-test-partition.sh (pattern ${PATTERN}):"

fixture agree "$GOOD"
expect_agree "a correctly named Chromium test agrees with the pattern" agree 1

fixture empty 'func TestPlain(t *testing.T) {}'
expect_refused "an empty derived set is refused, not treated as agreement" \
	empty "Refusing to pass vacuously"

fixture misnamed "$GOOD
func TestChromiumOffConvention(t *testing.T) { findChromiumExecutable(nil) }"
expect_refused "a Chromium test named outside the convention is reported as missing" \
	misnamed "$MISSING" "${I}TestChromiumOffConvention"

fixture extra "$GOOD
func TestBrowserNoChromeIntegration(t *testing.T) {}"
expect_refused "a pattern match that never calls the probe is reported as extra" \
	extra "$EXTRA" "${I}TestBrowserNoChromeIntegration"

# One in, one out: both sets have two members. The guard's own comment says a
# count is blind to this, so a guard that compared counts must fail here.
fixture swap "$GOOD
func TestChromiumOffConvention(t *testing.T) { findChromiumExecutable(nil) }
func TestBrowserNoChromeIntegration(t *testing.T) {}"
expect_refused "a swap with equal counts is still a mismatch, in both directions" \
	swap "$MISSING" "$EXTRA" "${I}TestChromiumOffConvention" "${I}TestBrowserNoChromeIntegration"

# The deriver exits 1 here, so its failure has to reach the script's own error.
# With `|| true` on the `go run` the derived set comes back empty instead, and
# only the vacuous-set message is printed.
fixture helper "$GOOD
func launch() { findChromiumExecutable(nil) }"
expect_refused "a probe call in a helper fails the derivation" \
	helper "::error::deriving the Chromium test set" "cannot be attributed"

# Go's test-name rule: Test followed by a lowercase letter is an ordinary
# function. Read as a test, Testable would be derived and reported as missing
# from the pattern instead of as an unattributed call.
fixture testable "$GOOD
func Testable() { findChromiumExecutable(nil) }"
expect_refused "Testable is not a test name, so its probe call is unattributed" \
	testable "cannot be attributed"

# The probe inside a subtest is still the test's own call. A deriver that did
# not look inside function literals would derive nothing for this test and
# report nothing either, and it would run un-retried.
fixture closure "$GOOD
func TestUnretriedSubtest(t *testing.T) {
	t.Run(\"page\", func(t *testing.T) { findChromiumExecutable(nil) })
}"
expect_refused "a probe call inside a subtest closure belongs to its test" \
	closure "$MISSING" "${I}TestUnretriedSubtest"

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
expect_refused "a func line inside a raw string does not reattribute a probe call" \
	rawstring "$MISSING" "${I}TestUnretried"

# The file set is what the go tool compiles. A Chromium test excluded by a build
# constraint can never come back from `go test -list` on this GOOS, so deriving
# it would be a red nobody could fix.
fixture constrained "$GOOD"
printf '//go:build never\n\npackage fixture\n\nimport "testing"\n\n%s\n' \
	'func TestBrowserBIntegration(t *testing.T) { findChromiumExecutable(nil) }' \
	>"${WORK}/constrained/never_test.go"
expect_agree "a Chromium test excluded by a build constraint is not derived" constrained 1

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
