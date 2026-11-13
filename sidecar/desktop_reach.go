package main

// Whether keys sent now would arrive, and which window of a program is the one
// a person means. Decisions only, with no platform calls in them, so they run
// and are tested on every platform. Windows feeds them (win32_reach_windows.go).

import (
	"fmt"
	"time"
)

// desktopTargetUnreachableCode marks keys refused because the window in front
// runs as administrator and this program does not: Windows drops every key
// sent across that line, without an error. It is returned before the first key
// is sent, so the daemon may report it as not started (NOT_STARTED_RPC_CODES
// in src/actions/tools/sidecar-route.ts).
const desktopTargetUnreachableCode = "DESKTOP_TARGET_UNREACHABLE"

type keyReach int

const (
	// keysArrive: nothing stands between this program and the window.
	keysArrive keyReach = iota
	// keysBlocked: the window runs as administrator and this program does not.
	keysBlocked
	// keysUnconfirmed: the window's program could not be asked. Usually it is
	// a protected one, and keys do not arrive; it cannot be said for sure.
	keysUnconfirmed
)

// keysReachWindow decides it from what could be read: whether this program
// runs as administrator, and whether the window's does. A program that runs
// as administrator itself reaches every window.
func keysReachWindow(selfElevated, selfKnown, targetElevated, targetKnown bool) keyReach {
	switch {
	case selfKnown && selfElevated:
		return keysArrive
	case !targetKnown:
		return keysUnconfirmed
	case !targetElevated:
		return keysArrive
	case selfKnown:
		return keysBlocked
	}
	return keysUnconfirmed
}

// delivery is the word a reply carries for it. A fixed word, never text read
// from the machine: the reply of a typing tool is trusted as it is.
func (r keyReach) delivery() string {
	if r == keysUnconfirmed {
		return "unconfirmed"
	}
	return "sent"
}

// keysBlockedError is the refusal. `what` is what was not done ("typed",
// "pressed"); `after` is what had already been done, or "".
func keysBlockedError(what, after string) error {
	text := fmt.Sprintf("the window in front runs as administrator and Jarvis does not, so Windows drops every key sent to it: nothing was %s. "+
		"Jarvis can neither type into that window nor read it. Tell the user so; do NOT retry", what)
	if after != "" {
		// Something was done first: this is not a refusal before anything happened.
		return fmt.Errorf("%s, but %s", after, text)
	}
	return &codedError{code: desktopTargetUnreachableCode, err: fmt.Errorf("%s", text)}
}

// typeLineBreakIsSoft reads how a line break in typed text is to be typed:
// "enter" (the default) is the Enter key, "shift_enter" is Shift+Enter, which
// is a new line in a chat app where Enter alone sends the message.
func typeLineBreakIsSoft(params map[string]any) (bool, error) {
	raw, given := params["line_break"]
	if !given || raw == nil {
		return false, nil
	}
	switch raw {
	case "", "enter":
		return false, nil
	case "shift_enter":
		return true, nil
	}
	return false, fmt.Errorf("line_break must be \"enter\" or \"shift_enter\", got %v", raw)
}

// pidWindow is a window of one program, as the picker needs it.
type pidWindow struct {
	Hwnd      uintptr
	Minimized bool
}

// pickWindowOfPid chooses which of a program's windows "the window of this
// program" means. They are given front to back. One program can own many:
// File Explorer owns every folder window and the desktop, and one host program
// owns Calculator, Settings and the Store at once. The first one found used to
// be taken, whichever it was. A person means the one they are looking at: the
// window in front if it is this program's, else the frontmost that is not
// minimised, else the frontmost.
func pickWindowOfPid(wins []pidWindow, foreground uintptr) uintptr {
	for _, w := range wins {
		if w.Hwnd == foreground {
			return w.Hwnd
		}
	}
	for _, w := range wins {
		if !w.Minimized {
			return w.Hwnd
		}
	}
	if len(wins) > 0 {
		return wins[0].Hwnd
	}
	return 0
}

// pointerUnderNotch is the refusal for a click whose point is under Jarvis's
// own notch. The usual advice (bring the window forward) cannot help: the
// notch is above every window.
func pointerUnderNotch(what string, x, y int) string {
	return fmt.Sprintf("%s is under Jarvis's own notch at (%d, %d), so nothing was clicked. "+
		"The notch stays above every window, so bringing the window forward will not help. "+
		"Use an action that needs no pointer (invoke, set_value, or focus followed by desktop_press_keys), "+
		"or try again in a few seconds when the notch has folded back", what, x, y)
}

// How much of one window a single read lists, and for how long it reads. A
// read that ran past what its caller waits for was reported as "may or may not
// have taken effect"; these keep it inside that wait (30 s) with room to spare.
const (
	walkElementLimit = 3000
	walkTimeLimit    = 15 * time.Second
)

// walkBudget is what one read of a window may still spend.
type walkBudget struct {
	limit    int
	deadline time.Time
	capped   bool
	now      func() time.Time
}

func newWalkBudget() *walkBudget {
	return &walkBudget{limit: walkElementLimit, deadline: time.Now().Add(walkTimeLimit), now: time.Now}
}

// spent says whether the read must stop, given how many elements it has
// listed. Once true it stays true, and `capped` records that it happened.
func (b *walkBudget) spent(listed int) bool {
	if b == nil {
		return false
	}
	if !b.capped && (listed >= b.limit || !b.now().Before(b.deadline)) {
		b.capped = true
	}
	return b.capped
}
