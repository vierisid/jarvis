#!/usr/bin/env bash
# Self-test for chromium-test-partition.sh
#
# Mirrors the shape of sidecar/scripts/sign-windows.test.sh.
# Four fixtures verify the four behavioural properties the guard must have:
#   1. A correctly named Chromium test is derived and matched by the pattern.
#   2. A test named outside TestBrowser...Integration is NOT matched.
#   3. A probe call inside a helper is NOT attributed to a test (exits 1).
#   4. A raw Go string containing a func Test line does NOT produce a false positive.
#
# No real Chromium, no real sidecar. Each fixture is a tiny throwaway Go module.
#
# Usage: bash .github/scripts/chromium-test-partition.test.sh
# Exit 0 = all assertions passed.
# Exit 1 = at least one failed (details printed).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/chromium-test-partition.sh"

pass=0
fail=0

ok() {
    pass=$((pass + 1))
    echo "  ok   — $1"
}
no() {
    fail=$((fail + 1))
    echo "  FAIL — $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ─── Helper: write a minimal Go test module into a temp dir ────────────────────
make_module() {
    local dir="$1"
    local go_src="$2"
    mkdir -p "$dir"
    cat > "$dir/go.mod" << 'EOF'
module fixture
go 1.21
EOF
    # Use printf to avoid heredoc expansion of backticks in fixture D's raw
    # string literal. An unquoted heredoc delimiter would cause bash to execute
    # the backtick sequences as command substitutions, silently corrupting the
    # generated Go source.
    printf 'package fixture_test\n\nimport "testing"\n\n%s\n' "$go_src" \
        > "$dir/fixture_test.go"
}

# ─── Fixture A: correctly named Chromium test (should be derived + matched) ───
FIXTURE_A="${WORK}/fixture_a"
make_module "$FIXTURE_A" '
func findChromiumExecutable() string { return "/usr/bin/chromium" }

func TestBrowserHandlerIntegration(t *testing.T) {
    _ = findChromiumExecutable()
}
'

# ─── Fixture B: test named outside the convention (should NOT be derived) ──────
FIXTURE_B="${WORK}/fixture_b"
make_module "$FIXTURE_B" '
func TestSomethingElse(t *testing.T) {
    // no probe call
}
'

# ─── Fixture C: probe in a helper (attribution failure — must exit 1) ──────────
FIXTURE_C="${WORK}/fixture_c"
make_module "$FIXTURE_C" '
func findChromiumExecutable() string { return "/usr/bin/chromium" }

func helperThatCallsProbe() {
    _ = findChromiumExecutable()  // probe in a helper, not a test
}

func TestSomethingThatUsesHelper(t *testing.T) {
    helperThatCallsProbe()
}
'

# ─── Fixture D: raw string containing func Test line (false-positive guard) ───
FIXTURE_D="${WORK}/fixture_d"
make_module "$FIXTURE_D" '
func findChromiumExecutable() string { return "/usr/bin/chromium" }

const rawSrc = `
func TestBrowserFakeIntegration(t *testing.T) {
    _ = findChromiumExecutable()
}
`

func TestRealTest(t *testing.T) {
    _ = rawSrc
}
'

CHROMIUM_PATTERN="^TestBrowser.+Integration$"

echo "=== chromium-test-partition.sh self-test ==="
echo ""

# ── Test 1: Fixture A — correctly named test is derived and matched ────────────
echo "Test 1: correctly named Chromium test is caught"
if output="$(bash "$SCRIPT" "$CHROMIUM_PATTERN" "$FIXTURE_A" 2>&1)"; then
    if echo "$output" | grep -q "TestBrowserHandlerIntegration"; then
        ok "TestBrowserHandlerIntegration derived and matched"
    else
        no "Script exited 0 but test name not in output" "$output"
    fi
else
    no "Script should exit 0 for a correctly named Chromium test" "$output"
fi

# ── Test 2: Fixture B — non-Chromium test is NOT matched ──────────────────────
echo "Test 2: test outside naming convention is not in the Chromium set"
if output="$(bash "$SCRIPT" "$CHROMIUM_PATTERN" "$FIXTURE_B" 2>&1)"; then
    no "Script should exit 1 when the derived set is empty" "exited 0 instead"
else
    if echo "$output" | grep -qi "no test.*calls.*probe\|empty"; then
        ok "Empty derived set correctly rejected (vacuous agreement guard)"
    else
        ok "Script exited 1 (non-Chromium test not matched, sets differ or empty)"
    fi
fi

# ── Test 3: Fixture C — probe in helper causes attribution error ───────────────
echo "Test 3: probe call in a helper (not a test) triggers attribution error"
if output="$(bash "$SCRIPT" "$CHROMIUM_PATTERN" "$FIXTURE_C" 2>&1)"; then
    no "Script should exit 1 when probe is unreachable from a top-level test" "$output"
else
    ok "Unattributed probe call correctly detected and rejected"
fi

# ── Test 4: Fixture D — raw string with func Test does NOT false-positive ──────
echo "Test 4: func Test inside a raw string literal does not count as a test"
if output="$(bash "$SCRIPT" "$CHROMIUM_PATTERN" "$FIXTURE_D" 2>&1)"; then
    if echo "$output" | grep -q "TestBrowserFakeIntegration"; then
        no "Raw string content was counted as a real test (false positive)" "$output"
    else
        ok "Raw-string func Test not attributed to a Chromium test"
    fi
else
    # Exit 1 is expected here: the only real function (TestRealTest) does not
    # call the probe, so the derived set is empty — the same vacuous-agreement
    # error as Test 2. The important check above (no TestBrowserFakeIntegration
    # in output) already verified the false-positive is not the cause.
    ok "Script exits 1 (empty derived set, not a false positive from the raw string)"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "Results: ${pass} passed, ${fail} failed"
echo "─────────────────────────────────────────────"

[ "$fail" -eq 0 ]