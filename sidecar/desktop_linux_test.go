//go:build linux

package main

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

// launch_app's whole point is that the caller can trust what it says, so the
// mapping from "what the probe established" to "what the model is told" is
// pinned here rather than left to the handler's branches.
func TestLaunchResultLinuxReportsEachProbeHonestly(t *testing.T) {
	probeErr := errors.New("window check unavailable: xdotool is not installed")

	tests := []struct {
		name          string
		win           map[string]any
		probe         launchProbe
		probeErr      error
		wantSuccess   any
		wantVisible   any
		wantNote      bool
		noteMustCarry string
	}{
		{
			name:        "window observed",
			win:         map[string]any{"title": "Text Editor"},
			probe:       probeWindowFound,
			wantSuccess: true,
			wantVisible: true,
		},
		{
			name:          "probe ran and saw nothing",
			probe:         probeWindowAbsent,
			wantSuccess:   false,
			wantVisible:   false,
			wantNote:      true,
			noteMustCarry: "no window appeared",
		},
		{
			name:          "process died before showing a window",
			probe:         probeProcessGone,
			wantSuccess:   false,
			wantVisible:   false,
			wantNote:      true,
			noteMustCarry: "exited without showing a window",
		},
		{
			// The one that matters most: an unreadable probe must not be
			// dressed up as a failed launch, or every GUI app started on a
			// Wayland session gets reported as broken and relaunched.
			name:          "probe could not run",
			probe:         probeUncheckable,
			probeErr:      probeErr,
			wantSuccess:   true,
			wantVisible:   nil,
			wantNote:      true,
			noteMustCarry: "could NOT be checked",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := launchResultLinux(4242, "gedit", tc.win, tc.probe, tc.probeErr)
			m, ok := res.Result.(map[string]any)
			if !ok {
				t.Fatalf("result is not a map: %T", res.Result)
			}
			if m["success"] != tc.wantSuccess {
				t.Errorf("success = %v, want %v", m["success"], tc.wantSuccess)
			}
			// Assert presence separately: a missing key also reads as nil,
			// and "we could not tell" has to be stated, not left out.
			got, present := m["window_visible"]
			if !present {
				t.Error("window_visible must always be reported, even when unknown")
			}
			if got != tc.wantVisible {
				t.Errorf("window_visible = %v, want %v", got, tc.wantVisible)
			}
			if m["pid"] != 4242 {
				t.Errorf("pid = %v, want 4242", m["pid"])
			}
			note, _ := m["note"].(string)
			if tc.wantNote {
				if note == "" {
					t.Fatal("expected an explanatory note")
				}
				if !strings.Contains(note, tc.noteMustCarry) {
					t.Errorf("note %q does not explain %q", note, tc.noteMustCarry)
				}
			} else if note != "" {
				t.Errorf("a confirmed window needs no caveat, got note %q", note)
			}
		})
	}
}

// An unverified launch must not read as a failed one. The note is the only
// thing standing between the model and a duplicate launch, so it has to say
// out loud that this is not a failure and name what to do instead.
func TestUncheckableLaunchNoteDoesNotReadAsFailure(t *testing.T) {
	res := launchResultLinux(7, "gimp", nil, probeUncheckable, errors.New("xdotool is not installed"))
	note := res.Result.(map[string]any)["note"].(string)

	for _, want := range []string{"not a failure", "desktop_list_windows", "do not launch it again"} {
		if !strings.Contains(note, want) {
			t.Errorf("note is missing %q: %s", want, note)
		}
	}
	if strings.Contains(note, "xdotool is not installed") == false {
		t.Errorf("note should carry the underlying reason: %s", note)
	}
}

// The whole three-state contract rests on reading one xdotool run
// correctly, and the trap is that a clean no-match and a total failure both
// exit 1. Returning no error means "there is no window", so anything the
// classifier is not certain about has to come back as unavailable instead.
func TestClassifyWindowSearchSeparatesNoMatchFromNoAnswer(t *testing.T) {
	tests := []struct {
		name        string
		run         probeRun
		wantIDs     int
		wantUnavail bool
		wantReason  string
	}{
		{
			name:    "windows found",
			run:     probeRun{stdout: "12582917 12582919", exitCode: 0},
			wantIDs: 2,
		},
		{
			name:    "ran cleanly and matched nothing",
			run:     probeRun{exitCode: 1, err: &exec.ExitError{}},
			wantIDs: 0,
		},
		{
			// No X to talk to. xdotool still exits 1, so only stderr tells
			// us this was not an answer.
			name:        "no display",
			run:         probeRun{stderr: "Error: Can't open display: (null)\n", exitCode: 1, err: &exec.ExitError{}},
			wantUnavail: true,
			wantReason:  "Can't open display",
		},
		{
			name:        "killed by the timeout",
			run:         probeRun{exitCode: -1, timedOut: true, err: errors.New("signal: killed")},
			wantUnavail: true,
			wantReason:  "did not return in time",
		},
		{
			// A timeout that still managed to exit 1 must not be read as a
			// no-match just because the status happens to line up.
			name:        "timed out with a matching exit status",
			run:         probeRun{exitCode: 1, timedOut: true, err: errors.New("signal: killed")},
			wantUnavail: true,
			wantReason:  "did not return in time",
		},
		{
			name:        "unexpected exit status",
			run:         probeRun{exitCode: 2, err: &exec.ExitError{}},
			wantUnavail: true,
			wantReason:  "could not run xdotool",
		},
		{
			name:        "never started",
			run:         probeRun{exitCode: -1, err: errors.New("fork/exec: permission denied")},
			wantUnavail: true,
			wantReason:  "could not run xdotool",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ids, err := classifyWindowSearch(tc.run)
			if tc.wantUnavail {
				if !errors.Is(err, errWindowCheckUnavailable) {
					t.Fatalf("want an unavailable check, got ids=%v err=%v", ids, err)
				}
				if !strings.Contains(err.Error(), tc.wantReason) {
					t.Errorf("error %q should explain %q", err, tc.wantReason)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(ids) != tc.wantIDs {
				t.Errorf("got %d window ids %v, want %d", len(ids), ids, tc.wantIDs)
			}
		})
	}
}

// A missing xdotool is the commonest way the check cannot run, and it must
// not be reported as the absence of a window.
func TestProbeWindowOnceFlagsAMissingToolAsUnavailable(t *testing.T) {
	if _, err := exec.LookPath("xdotool"); err == nil {
		t.Skip("xdotool is installed here; the missing-tool branch cannot be exercised")
	}
	if _, err := probeWindowOnce(1); !errors.Is(err, errWindowCheckUnavailable) {
		t.Fatalf("a missing xdotool must be unavailable, not absence of a window: %v", err)
	}
}
