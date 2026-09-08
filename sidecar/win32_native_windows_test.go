//go:build windows

package main

import (
	"strings"
	"testing"
)

// UIA answers S_OK with a null pattern when a control simply does not
// implement one, and uiaElementGetPattern funnels that through hresultText
// with hr = 0. Rendering it as a raw zero HRESULT plus "retry once" sent the
// model back around a loop that could never succeed.
func TestHresultTextExplainsAnUnsupportedPattern(t *testing.T) {
	got := hresultText(0)
	if strings.Contains(got, "0x00000000") {
		t.Errorf("a null pattern is not an error code to show the model: %s", got)
	}
	if strings.Contains(strings.ToLower(got), "retry") {
		t.Errorf("an unsupported pattern will never start working, so do not ask for a retry: %s", got)
	}
	if !strings.Contains(got, "does not expose this pattern") {
		t.Errorf("should name the actual problem: %s", got)
	}
}

// The mapped failures each need to survive as actionable text rather than a
// bare code, and the fallback must still say what to do with an unknown one.
func TestHresultTextMapsKnownUiaFailures(t *testing.T) {
	cases := map[uintptr]string{
		0x80040201: "no longer exists",
		0x80040200: "disabled",
		0x80040202: "scroll_into_view",
		0x80070005: "elevated",
		0x80004005: "rejected the action",
	}
	for hr, want := range cases {
		if got := hresultText(hr); !strings.Contains(got, want) {
			t.Errorf("hresultText(0x%08x) = %q, want it to mention %q", uint32(hr), got, want)
		}
	}
	if got := hresultText(0x8000FFFF); !strings.Contains(got, "0x8000ffff") {
		t.Errorf("an unmapped HRESULT should still be reported verbatim: %s", got)
	}
}

// The process-name fallback exists because packaged apps hand their window
// to a broker, but it is also the one match that can pick up a window this
// launch had nothing to do with. Reporting a window from an instance the
// user already had open is a false success, and worse, it hands back a PID
// the model will then try to drive.
func TestPickLaunchedWindowIgnoresWindowsThatWereAlreadyOpen(t *testing.T) {
	existing := windowInfo{Hwnd: 0x100, Title: "Calculator", Pid: 900, ProcessName: "Calculator"}
	fresh := windowInfo{Hwnd: 0x200, Title: "Calculator", Pid: 901, ProcessName: "Calculator"}
	ownWindow := windowInfo{Hwnd: 0x300, Title: "Notepad", Pid: 42, ProcessName: "notepad"}
	preexisting := map[uintptr]bool{existing.Hwnd: true}

	t.Run("a window owned by the launched pid wins outright", func(t *testing.T) {
		got, how := pickLaunchedWindow([]windowInfo{existing, ownWindow}, 42, "notepad", true, preexisting)
		if got == nil || got.Hwnd != ownWindow.Hwnd {
			t.Fatalf("got %+v, want the pid-owned window", got)
		}
		if how != "pid" {
			t.Errorf("matched by %q, want \"pid\"", how)
		}
	})

	t.Run("an already-open window is never claimed as the launch result", func(t *testing.T) {
		got, how := pickLaunchedWindow([]windowInfo{existing}, 42, "calc", true, preexisting)
		if got != nil {
			t.Fatalf("claimed a pre-existing window %+v (matched by %q)", got, how)
		}
	})

	t.Run("a new window from the broker process is claimed", func(t *testing.T) {
		got, how := pickLaunchedWindow([]windowInfo{existing, fresh}, 42, "calculator", true, preexisting)
		if got == nil || got.Hwnd != fresh.Hwnd {
			t.Fatalf("got %+v, want the newly opened window", got)
		}
		if how != "process_name" {
			t.Errorf("matched by %q, want \"process_name\"", how)
		}
	})

	t.Run("the name fallback stays shut until it is allowed", func(t *testing.T) {
		if got, _ := pickLaunchedWindow([]windowInfo{fresh}, 42, "calculator", false, preexisting); got != nil {
			t.Fatalf("name matching ran before its turn: %+v", got)
		}
	})

	t.Run("no executable name means no name matching", func(t *testing.T) {
		if got, _ := pickLaunchedWindow([]windowInfo{fresh}, 42, "", true, preexisting); got != nil {
			t.Fatalf("matched %+v with nothing to match against", got)
		}
	})
}
