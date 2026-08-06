//go:build !windows && !darwin

package main

// Console dialogs (Linux and anything else — the installer product targets
// Windows and macOS, but the package must build everywhere).

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// confirm asks a yes/no question on the console, defaulting to No.
func confirm(title, text string) bool {
	fmt.Fprintf(os.Stderr, "\n%s\n%s\n[y/N] ", title, text)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(line), "y")
}

// notify reports a terminal outcome.
func notify(title, text string, _ bool) {
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, text)
}
