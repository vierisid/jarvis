//go:build linux

package main

import (
	"errors"
	"strings"
	"testing"
)

// #705: an element that passes #661's read-back -- same role, name and rect --
// can still be covered by another window, or sit on another workspace, and
// AT-SPI's extents say nothing about stacking. A click at its centre then
// lands on whatever is on top. Driven through the fake xdotool, which reports
// the window under the pointer and that window's pid.

func clicked(calls []string) bool {
	for _, c := range calls {
		if strings.HasPrefix(c, "click") || strings.Contains(c, " click ") {
			return true
		}
	}
	return false
}

func TestClickElementRefusesWhenAnotherWindowCoversIt(t *testing.T) {
	for _, tc := range []struct {
		name   string
		cover  string
		action string
		says   string
	}{
		{"another program's window on top", "9999", "click", "another program (pid 9999"},
		{"another program's window on top, double click", "9999", "double_click", "another program"},
		{"a window with no owner to check", "none", "right_click", "cannot be read"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := fakeDesktop(t)
			s.show(cancelButton, deleteButton)
			ids := s.snapshot()
			s.coverWith(tc.cover)

			_, err := handleClickElement(map[string]any{"element_id": ids[0], "action": tc.action})
			var coded *codedError
			if !errors.As(err, &coded) || coded.code != desktopTargetObscuredCode {
				t.Fatalf("got %v, want a %s refusal", err, desktopTargetObscuredCode)
			}
			if !strings.Contains(err.Error(), "nothing was clicked") || !strings.Contains(err.Error(), tc.says) {
				t.Errorf("refusal %q does not say nothing was clicked, and why (%q)", err, tc.says)
			}
			calls := s.pointerCalls()
			if clicked(calls) {
				t.Errorf("refused, but xdotool clicked: %q", calls)
			}
			// And the pointer went back to where it was (X=1, Y=2 in the fake).
			if len(calls) == 0 || calls[len(calls)-1] != "mousemove 1 2" {
				t.Errorf("the pointer was not put back: %q", calls)
			}
		})
	}
}

func TestTypeTextRefusesACoveredElementWithoutTyping(t *testing.T) {
	s := fakeDesktop(t)
	s.show(nameField)
	ids := s.snapshot()
	s.coverWith("9999")

	if _, err := handleTypeText(map[string]any{"element_id": ids[0], "text": "hunter2"}); err == nil {
		t.Fatal("typed into a covered field")
	}
	for _, c := range s.pointerCalls() {
		if strings.HasPrefix(c, "type") || clicked([]string{c}) {
			t.Errorf("refused, but xdotool ran %q", c)
		}
	}
}

func TestClickElementClicksWhenItsOwnWindowIsOnTop(t *testing.T) {
	s := fakeDesktop(t)
	s.show(cancelButton, deleteButton)
	ids := s.snapshot()
	s.coverWith("4242") // the snapshot's own pid

	res, err := handleClickElement(map[string]any{"element_id": ids[1]})
	if err != nil {
		t.Fatalf("an uncovered element was refused: %v", err)
	}
	if res.Result.(map[string]any)["window_under_pointer_checked"] != true {
		t.Errorf("the reply does not say the window under the pointer was checked: %v", res.Result)
	}
	got := s.pointerCalls()
	// Where the pointer was, the move and the window under it; then the click,
	// which re-places the pointer itself.
	want := []string{"getmouselocation --shell mousemove --sync 260 415 getmouselocation --shell getwindowpid",
		"mousemove --sync 260 415 click 1"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("xdotool ran %q, want %q", got, want)
	}
}

func TestClickElementWithoutAWindowSystemIsNotReportedAsCovered(t *testing.T) {
	// xdotool that cannot reach a display is not a covered element: telling
	// the model to refocus and retry would loop.
	s := fakeDesktop(t)
	s.show(cancelButton)
	ids := s.snapshot()
	s.coverWith("nodisplay")
	_, err := handleClickElement(map[string]any{"element_id": ids[0]})
	var coded *codedError
	if err == nil || errors.As(err, &coded) || !strings.Contains(err.Error(), "Can't open display") {
		t.Fatalf("got %v, want an uncoded failure carrying xdotool's error", err)
	}
	if calls := s.pointerCalls(); clicked(calls) {
		t.Errorf("clicked without a window to check: %q", calls)
	}
}

func TestPointerOriginIsWhereThePointerWasBeforeTheMove(t *testing.T) {
	out := "X=5\nY=6\nSCREEN=0\nWINDOW=1\nX=260\nY=415\nSCREEN=0\nWINDOW=77\n4242\n"
	if x, y, ok := pointerOrigin(out); !ok || x != 5 || y != 6 {
		t.Errorf("pointerOrigin = %d, %d, %v; want 5, 6, true", x, y, ok)
	}
	if w, pid, ok := windowUnderPointer(out); !ok || w != "77" || pid != 4242 {
		t.Errorf("windowUnderPointer = %q, %d, %v; want the window after the move", w, pid, ok)
	}
}

func TestWindowUnderPointerParsesXdotool(t *testing.T) {
	for _, tc := range []struct {
		out    string
		pid    int
		window string
		ok     bool
	}{
		{"X=1\nY=2\nSCREEN=0\nWINDOW=77\n4242\n", 4242, "77", true},
		{"X=1\nY=2\nSCREEN=0\nWINDOW=77\n", 0, "77", false}, // getwindowpid failed
		{"", 0, "", false},
		{"X=1\nY=2\nSCREEN=0\nWINDOW=77\nnot-a-pid\n", 0, "77", false},
	} {
		window, pid, ok := windowUnderPointer(tc.out)
		if window != tc.window || pid != tc.pid || ok != tc.ok {
			t.Errorf("windowUnderPointer(%q) = %q, %d, %v; want %q, %d, %v", tc.out, window, pid, ok, tc.window, tc.pid, tc.ok)
		}
	}
}
