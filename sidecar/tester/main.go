// tester — Standalone integration tester for sidecar platform capabilities.
//
// Each platform has its own tester_<os>.go file that validates the
// platform-specific APIs (COM vtable offsets on Windows, accessibility
// APIs on macOS, etc.) without needing the full sidecar WebSocket
// infrastructure.
//
// Build:  make test          (from sidecar/)
// Run:    tester/bin/tester_windows_amd64.exe   (on target machine)
package main

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

// testResult holds the outcome of a single test case.
type testResult struct {
	name    string
	passed  bool
	skipped bool
	err     error
	dur     time.Duration
	logs    []string
}

// testCtx is passed to each test function for logging and assertions.
type testCtx struct {
	name    string
	failed  bool
	skipped bool
	err     error
	logs    []string
}

func (t *testCtx) Logf(format string, args ...any) {
	t.logs = append(t.logs, fmt.Sprintf(format, args...))
}

func (t *testCtx) Errorf(format string, args ...any) {
	t.failed = true
	t.logs = append(t.logs, fmt.Sprintf("ERROR: "+format, args...))
}

func (t *testCtx) Fatalf(format string, args ...any) {
	t.failed = true
	t.err = fmt.Errorf(format, args...)
	panic(testFatal{})
}

func (t *testCtx) Skipf(format string, args ...any) {
	t.skipped = true
	t.logs = append(t.logs, fmt.Sprintf("SKIP: "+format, args...))
	panic(testSkip{})
}

type testFatal struct{}
type testSkip struct{}

// testFn is the signature for a test function.
type testFn func(t *testCtx)

// runTest executes a single test with panic recovery.
func runTest(name string, fn testFn) testResult {
	t := &testCtx{name: name}
	start := time.Now()

	func() {
		defer func() {
			if r := recover(); r != nil {
				switch r.(type) {
				case testFatal:
					// already recorded in t.err
				case testSkip:
					// already recorded in t.skipped
				default:
					t.failed = true
					t.err = fmt.Errorf("panic: %v", r)
				}
			}
		}()
		fn(t)
	}()

	return testResult{
		name:    name,
		passed:  !t.failed && !t.skipped,
		skipped: t.skipped,
		err:     t.err,
		dur:     time.Since(start),
		logs:    t.logs,
	}
}

func main() {
	fmt.Printf("=== Sidecar Tester (%s/%s) ===\n\n", runtime.GOOS, runtime.GOARCH)

	tests := platformTests()
	if len(tests) == 0 {
		fmt.Println("No tests registered for this platform.")
		os.Exit(0)
	}

	var passed, failed, skipped int

	for _, test := range tests {
		result := runTest(test.name, test.fn)

		// Status prefix
		status := "PASS"
		if result.skipped {
			status = "SKIP"
			skipped++
		} else if !result.passed {
			status = "FAIL"
			failed++
		} else {
			passed++
		}

		fmt.Printf("[%s] %s (%s)\n", status, result.name, result.dur.Round(time.Millisecond))

		// Print logs for failures or verbose
		if !result.passed || len(result.logs) > 0 {
			for _, l := range result.logs {
				fmt.Printf("       %s\n", l)
			}
			if result.err != nil {
				fmt.Printf("       %v\n", result.err)
			}
		}
	}

	fmt.Printf("\n--- Results: %d passed, %d failed, %d skipped ---\n", passed, failed, skipped)

	if failed > 0 {
		os.Exit(1)
	}
}

// testCase pairs a name with a test function.
type testCase struct {
	name string
	fn   testFn
}
