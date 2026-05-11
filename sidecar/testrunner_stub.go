//go:build !sidecartest

package main

import (
	"fmt"
	"os"
)

// runTests is the no-op stub compiled into production builds. The real
// implementation lives in testrunner_enabled.go and is selected via the
// `sidecartest` build tag.
func runTests(_ []string) int {
	fmt.Fprintln(os.Stderr, "--test was passed but this binary was not built with platform tests.")
	fmt.Fprintln(os.Stderr, "Rebuild with: make build-test")
	return 1
}
