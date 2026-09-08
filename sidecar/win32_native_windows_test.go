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

// VkKeyScanW answers with the virtual key in the low byte and the modifiers
// that key needs in the high byte. Dropping the high byte is how asking for
// "?" ends up typing "/" - the wrong character, and silently.
func TestVkScanShiftStateDecodesTheModifierBits(t *testing.T) {
	tests := []struct {
		name  string
		state uint16
		want  []uint16
	}{
		{"unmodified", 0x00, nil},
		{"shift", 0x01, []uint16{vkShift}},
		{"ctrl", 0x02, []uint16{vkControl}},
		{"alt", 0x04, []uint16{vkMenu}},
		{"altgr is ctrl and alt together", 0x06, []uint16{vkControl, vkMenu}},
		{"all three", 0x07, []uint16{vkShift, vkControl, vkMenu}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := vkScanShiftState(tc.state)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

// Windows wants both halves of a surrogate pair in one SendInput call, so a
// chunk boundary must never fall inside a character. keyEventsForRune is
// what makes that possible: it renders a whole character at a time.
func TestKeyEventsForRuneKeepsACharacterWhole(t *testing.T) {
	t.Run("a BMP character is one down/up pair", func(t *testing.T) {
		got := keyEventsForRune(nil, 'a')
		if len(got) != 2 {
			t.Fatalf("got %d events, want 2", len(got))
		}
		if got[0].flags&keyeventfUnicode == 0 {
			t.Error("text should be injected as Unicode, not as a virtual key")
		}
		if got[0].flags&keyeventfKeyUp != 0 || got[1].flags&keyeventfKeyUp == 0 {
			t.Error("expected a keydown followed by a keyup")
		}
	})

	t.Run("an astral character stays a single indivisible group", func(t *testing.T) {
		got := keyEventsForRune(nil, '\U0001F600')
		if len(got) != 4 {
			t.Fatalf("got %d events, want 4 (two UTF-16 units, down and up each)", len(got))
		}
		if got[0].scan < 0xD800 || got[0].scan > 0xDBFF {
			t.Errorf("first unit %#04x is not a high surrogate", got[0].scan)
		}
		if got[2].scan < 0xDC00 || got[2].scan > 0xDFFF {
			t.Errorf("third unit %#04x is not a low surrogate", got[2].scan)
		}
	})

	t.Run("a newline becomes a real Enter, not a literal LF", func(t *testing.T) {
		got := keyEventsForRune(nil, '\n')
		if len(got) != 2 || got[0].vk != vkReturn {
			t.Fatalf("got %+v, want an Enter keypress", got)
		}
		if got[0].flags&keyeventfUnicode != 0 {
			t.Error("Enter must be a virtual key; most controls ignore a Unicode LF")
		}
	})

	t.Run("a carriage return is dropped", func(t *testing.T) {
		if got := keyEventsForRune(nil, '\r'); len(got) != 0 {
			t.Fatalf("got %d events, want none", len(got))
		}
	})
}
