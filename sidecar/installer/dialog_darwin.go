//go:build darwin

package main

// Native dialogs via osascript. The uninstaller is a .app the user
// double-clicks from Finder, so questions and results must be real dialogs;
// osascript works identically when the binary is run from a terminal.

import (
	"fmt"
	"os/exec"
	"strings"
)

// osaQuote renders a Go string as an AppleScript string literal.
func osaQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// confirm asks a yes/no question, defaulting to No. Cancel, a closed dialog,
// or an unavailable osascript all keep the safe default.
func confirm(title, text string) bool {
	script := fmt.Sprintf(
		`display dialog %s with title %s buttons {"No", "Yes"} default button "No" with icon caution`,
		osaQuote(text), osaQuote(title))
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "button returned:Yes")
}

// notify reports a terminal outcome.
func notify(title, text string, failed bool) {
	icon := "note"
	if failed {
		icon = "stop"
	}
	script := fmt.Sprintf(`display dialog %s with title %s buttons {"OK"} default button "OK" with icon %s`,
		osaQuote(text), osaQuote(title), icon)
	if err := exec.Command("osascript", "-e", script).Run(); err != nil {
		logf("%s: %s", title, text)
	}
}
