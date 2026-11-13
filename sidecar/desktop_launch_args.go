package main

// The arguments an app is started with, as Windows needs them written.
//
// launch_app hands them to Start-Process as one line, and the app splits that
// line at its spaces. A path with a space in it ("C:\Users\me\My Notes\a.txt")
// therefore arrived as two halves: Notepad asked whether to create a file
// called "C:\Users\me\My". A person who says "open that file in Notepad" means
// one file, so one path is written as one argument.
//
// Nothing here is Windows code: it is the writing only, so it is tested on
// every platform.

import (
	"fmt"
	"regexp"
	"strings"
)

// A path from a drive or a share: C:\..., C:/..., \\server\...
var launchRootedPath = regexp.MustCompile(`^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s])`)

// A second path, or a switch, later on the line: then it is not one path. A
// switch is a dash or a slash with a letter straight after it; a dash with a
// space after it is part of a name ("Artist - Title.mp3").
var launchSecondPart = regexp.MustCompile(`\s(?:[A-Za-z]:[\\/]|\\\\|-[^\s]|/[A-Za-z?])`)

// A file name's ending followed by a space: "in.txt out.txt" is two files.
var launchEndingThenMore = regexp.MustCompile(`\.[A-Za-z0-9]{1,5}\s`)

// launchQuoted writes one argument so that it stays one: in double quotes,
// with every backslash at its end doubled (or they would swallow the closing
// quote: before a quote, two backslashes are read as one).
func launchQuoted(arg string) string {
	trailing := len(arg) - len(strings.TrimRight(arg, `\`))
	return `"` + arg + strings.Repeat(`\`, trailing) + `"`
}

// launchLonePath says whether a line of arguments is one path with spaces in
// it and nothing else. `exists` says whether a path is there on this machine.
// What is there decides first: a line that names something that exists, whole,
// is that thing. Otherwise it is read: rooted at a drive or a share, not
// already quoted, with no switch, no second path, and no file ending followed
// by more.
func launchLonePath(line string, exists func(string) bool) bool {
	line = strings.TrimSpace(line)
	if !strings.ContainsAny(line, " \t") || strings.Contains(line, `"`) || !launchRootedPath.MatchString(line) {
		return false
	}
	if exists != nil && exists(line) {
		return true
	}
	return !launchSecondPart.MatchString(line) && !launchEndingThenMore.MatchString(line)
}

// launchArgLine is the line of arguments to start an app with. A list keeps
// each of its items whole. A single line is taken as written, unless it is one
// path with spaces in it, which is kept whole too.
func launchArgLine(params map[string]any, exists func(string) bool) (string, error) {
	raw, given := params["args"]
	if !given || raw == nil {
		return "", nil
	}
	switch v := raw.(type) {
	case string:
		if launchLonePath(v, exists) {
			return launchQuoted(strings.TrimSpace(v)), nil
		}
		return v, nil
	case []any:
		parts := make([]string, 0, len(v))
		for i, elem := range v {
			s, ok := elem.(string)
			if !ok {
				return "", fmt.Errorf("args[%d]: expected string, got %T", i, elem)
			}
			if strings.ContainsAny(s, " \t") && !strings.Contains(s, `"`) {
				s = launchQuoted(s)
			}
			parts = append(parts, s)
		}
		return strings.Join(parts, " "), nil
	default:
		return "", fmt.Errorf("args: expected string or array, got %T", raw)
	}
}
