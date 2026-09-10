package main

import (
	"errors"
	"strings"
)

// Shared vocabulary for the post-launch window check.
//
// launch_app used to answer "did a process spawn?", which is not the
// question the caller is asking: a spawned process that never puts a window
// on screen makes the next tool call fail with "no window found". The
// handlers now look for the window before reporting success, and that check
// has three possible outcomes, not two. Collapsing "I looked and there is no
// window" together with "I was not able to look" would trade the old
// false positive for an equally misleading false negative, so every platform
// keeps them apart.

// launchProbe records what a post-launch window check actually established.
type launchProbe int

const (
	probeWindowFound  launchProbe = iota // a visible window was observed
	probeWindowAbsent                    // the check ran and saw no window
	probeProcessGone                     // the process exited, so no window can appear
	probeUncheckable                     // the check could not run; nothing was established
)

// errWindowCheckUnavailable marks a probe failure that says nothing about
// the app itself: the tooling is missing, or permission to use it was
// refused. Waiting longer cannot change the answer, so poll loops stop on
// it instead of burning the whole timeout.
var errWindowCheckUnavailable = errors.New("window check unavailable")

// firstLine keeps a multi-line tool complaint to its useful first line.
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// processBaseNameOf reduces an executable argument to the bare name a
// running process reports, so the two can be compared.
//
// launch_app documents its parameter as "executable path or name", and the
// Windows launcher matches it against windowInfo.ProcessName, which is
// always the stem: no directory, no .exe. Comparing the raw argument means
// the match only ever succeeds for the bare-name form, and silently never
// fires for a path - which is what anything outside System32 is given as.
//
// It lives here rather than beside its Windows caller because it is nothing
// but string handling, and that is worth being able to test on any host.
// Windows separators are accepted in both directions and a drive-relative
// path ("C:app.exe") carries no separator at all, so neither is left to
// filepath, whose answer depends on the platform it was compiled for.
func processBaseNameOf(executable string) string {
	name := strings.TrimSpace(executable)
	if i := strings.LastIndexAny(name, `\/`); i >= 0 {
		name = name[i+1:]
	}
	if len(name) > 1 && name[1] == ':' {
		name = name[2:]
	}
	return strings.TrimSuffix(strings.ToLower(name), ".exe")
}
