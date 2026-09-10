package main

import (
	"strconv"
	"strings"
)

// appProcessPid finds the main process of a macOS app in the output of
// `ps -axo pid=,comm=`, where comm is the full path of each process's
// executable. app is launch_app's argument as `open -a` took it: an app name
// ("Google Chrome"), a bundle name ("Safari.app") or a bundle path. It returns
// the best matching pid, or 0 when nothing matches.
//
// It replaces `pgrep -n <name>`, which could not answer the question for most
// apps. pgrep is case-sensitive and `open -a` is not, so "Jarvis" never found
// the `jarvis` process. It matches a substring, so "Google Chrome" could pick
// the newer "Google Chrome Helper" and then wait on a process that never owns
// a window. And it only sees the process name, which is the executable
// ("Code", "Electron") rather than the app, cut short for long names. Each of
// those turned a launch that had worked into "process never appeared" or "no
// window", and the model launched the app again.
//
// A candidate is an executable inside <Bundle>.app/Contents/MacOS/, with
// <Bundle> the innermost bundle on the path, so helper apps nested under
// Contents/Frameworks never qualify. Candidates are ranked, and the newest
// (highest) pid wins only within a rank:
//
//  1. the bundle and its executable both carry the name (Firefox.app/.../firefox)
//  2. only the bundle does (Visual Studio Code.app/.../Code)
//  3. only the executable does, for an app `open -a` found by a name that is
//     not its bundle's filename
//
// The ranking is what keeps a second executable sitting beside the main one
// (Firefox's pingsender) from winning just by having started later.
//
// It lives outside desktop_darwin.go because it is nothing but string
// handling, and that is worth being able to test on any host.
func appProcessPid(psOutput, app string) int {
	want := strings.TrimRight(strings.TrimSpace(app), "/")
	if i := strings.LastIndex(want, "/"); i >= 0 {
		want = want[i+1:]
	}
	want = strings.TrimSuffix(strings.ToLower(want), ".app")
	if want == "" {
		return 0
	}

	const inBundle = ".app/contents/macos/"
	var best [3]int // highest pid seen per rank, best[0] being rank 1
	for _, line := range strings.Split(psOutput, "\n") {
		pidField, comm, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(pidField)
		if err != nil || pid <= 0 {
			continue
		}
		path := strings.ToLower(strings.TrimSpace(comm))
		i := strings.LastIndex(path, inBundle)
		if i < 0 {
			continue
		}
		binary := path[i+len(inBundle):]
		bundle := path[:i]
		if j := strings.LastIndex(bundle, "/"); j >= 0 {
			bundle = bundle[j+1:]
		}

		rank := -1
		switch {
		case bundle == want && binary == want:
			rank = 0
		case bundle == want:
			rank = 1
		case binary == want:
			rank = 2
		}
		if rank >= 0 && pid > best[rank] {
			best[rank] = pid
		}
	}
	for _, pid := range best {
		if pid != 0 {
			return pid
		}
	}
	return 0
}
