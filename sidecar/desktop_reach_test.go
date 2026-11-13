package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestKeysReachWindow(t *testing.T) {
	for _, c := range []struct {
		selfElevated, selfKnown, targetElevated, targetKnown bool
		want                                                 keyReach
		name                                                 string
	}{
		{false, true, false, true, keysArrive, "two ordinary programs"},
		{false, true, true, true, keysBlocked, "an administrator window in front of an ordinary Jarvis"},
		{true, true, true, true, keysArrive, "Jarvis as administrator reaches an administrator window"},
		{true, true, false, false, keysArrive, "Jarvis as administrator reaches a window it could not ask"},
		{false, true, false, false, keysUnconfirmed, "a window whose program could not be asked"},
		{false, false, true, true, keysUnconfirmed, "Jarvis could not ask about itself"},
		{false, false, false, true, keysArrive, "an ordinary window is reached by anyone"},
	} {
		if got := keysReachWindow(c.selfElevated, c.selfKnown, c.targetElevated, c.targetKnown); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
	if keysArrive.delivery() != "sent" || keysUnconfirmed.delivery() != "unconfirmed" {
		t.Error("the reply's word for delivery")
	}
}

func TestKeysBlockedErrorIsNotStartedOnlyWhenNothingWasDone(t *testing.T) {
	var coded *codedError
	if err := keysBlockedError("typed", ""); !errors.As(err, &coded) || coded.code != desktopTargetUnreachableCode {
		t.Errorf("a refusal before anything was done must carry the not-started code: %v", err)
	}
	err := keysBlockedError("typed", "element [4] was clicked")
	if errors.As(err, &coded) {
		t.Errorf("after a click it is not a refusal before anything happened: %v", err)
	}
	if !strings.Contains(err.Error(), "element [4] was clicked") || !strings.Contains(err.Error(), "nothing was typed") {
		t.Errorf("it must say what was and was not done: %v", err)
	}
}

func TestTypeLineBreakIsSoft(t *testing.T) {
	for _, c := range []struct {
		params map[string]any
		soft   bool
		ok     bool
	}{
		{map[string]any{}, false, true},
		{map[string]any{"line_break": nil}, false, true},
		{map[string]any{"line_break": "enter"}, false, true},
		{map[string]any{"line_break": "shift_enter"}, true, true},
		{map[string]any{"line_break": "ctrl_enter"}, false, false},
		{map[string]any{"line_break": true}, false, false},
	} {
		soft, err := typeLineBreakIsSoft(c.params)
		if soft != c.soft || (err == nil) != c.ok {
			t.Errorf("typeLineBreakIsSoft(%v) = %v, %v; want %v, ok %v", c.params, soft, err, c.soft, c.ok)
		}
	}
}

func TestPickWindowOfPid(t *testing.T) {
	wins := []pidWindow{{Hwnd: 10, Minimized: true}, {Hwnd: 11}, {Hwnd: 12}}
	if got := pickWindowOfPid(wins, 12); got != 12 {
		t.Errorf("the window in front is the one meant: got %d", got)
	}
	if got := pickWindowOfPid(wins, 99); got != 11 {
		t.Errorf("else the frontmost that is not minimised: got %d", got)
	}
	if got := pickWindowOfPid([]pidWindow{{Hwnd: 10, Minimized: true}, {Hwnd: 13, Minimized: true}}, 0); got != 10 {
		t.Errorf("else the frontmost: got %d", got)
	}
	if got := pickWindowOfPid(nil, 5); got != 0 {
		t.Errorf("no window: got %d", got)
	}
}

func TestPointerUnderNotchDoesNotSendTheModelInACircle(t *testing.T) {
	text := pointerUnderNotch("element [7]", 960, 14)
	if !strings.Contains(text, "element [7]") || !strings.Contains(text, "(960, 14)") || !strings.Contains(text, "nothing was clicked") {
		t.Errorf("it must say what and where: %s", text)
	}
	if strings.Contains(text, "desktop_focus_window") {
		t.Errorf("bringing the window forward cannot help under the notch: %s", text)
	}
}

func TestWalkBudgetStopsAtItsLimitsAndStaysStopped(t *testing.T) {
	now := time.Unix(1000, 0)
	budget := &walkBudget{limit: 3, deadline: now.Add(10 * time.Second), now: func() time.Time { return now }}
	if budget.spent(0) || budget.spent(2) || budget.capped {
		t.Error("under both limits the read goes on")
	}
	if !budget.spent(3) || !budget.capped {
		t.Error("at the element limit the read stops and says so")
	}
	if !budget.spent(0) {
		t.Error("once stopped it stays stopped")
	}
	late := &walkBudget{limit: 100, deadline: now.Add(10 * time.Second), now: func() time.Time { return now }}
	now = now.Add(10 * time.Second)
	if !late.spent(1) || !late.capped {
		t.Error("at the time limit the read stops and says so")
	}
	var none *walkBudget
	if none.spent(1 << 20) {
		t.Error("a read with no budget is not limited")
	}
	if fresh := newWalkBudget(); fresh.limit != walkElementLimit || fresh.spent(0) {
		t.Error("a new budget starts unspent")
	}
}
