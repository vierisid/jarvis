package main

import (
	"strings"
	"testing"
	"time"
)

// markHands are hands that can also lay a mark over a thing.
type markHands struct{ *fakeHands }

func (h markHands) Mark(r lookRect, stay time.Duration) {
	h.note("mark %d,%d %dx%d %v", r.X, r.Y, r.W, r.H, stay)
}
func (h markHands) MarkEnd() { h.note("mark end") }

// markWorld is a look with hands that can mark, and a window of 1200 by 800
// at 100,50 in front of the person.
func markWorld(t *testing.T) (RPCHandler, *fakeHands, *NotchLook) {
	t.Helper()
	fake := &fakeHands{}
	hands := markHands{fake}
	look := newNotchLook()
	look.Use(hands, func(app, title string) string { return "" }, func(map[string]any, []byte) {})
	t.Cleanup(look.Forget)
	prevHands, prevFront := notchLookHands, platformNotchFront
	t.Cleanup(func() { notchLookHands, platformNotchFront = prevHands, prevFront })
	notchLookHands = hands
	platformNotchFront = func() (lookRect, string, string, error) {
		return lookRect{100, 50, 1200, 800}, "slack.exe", "general", nil
	}
	return makeNotchMarkHandler(look), fake, look
}

var markWindow = map[string]any{"x": 100.0, "y": 50.0, "w": 1200.0, "h": 800.0}

func TestAMarkIsDrawnOverAThingInTheWindowThatWasLookedAt(t *testing.T) {
	handler, hands, _ := markWorld(t)
	got, err := handler(map[string]any{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "ms": 8000.0, "in": markWindow})
	if err != nil || got.Result.(map[string]any)["marked"] != true {
		t.Fatalf("%v %v", got, err)
	}
	if !hands.has("mark 300,400 500x24 8s") {
		t.Fatalf("%v", hands.log())
	}
	// How long it stays is kept within reason.
	handler(map[string]any{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "ms": 9e9, "in": markWindow})
	handler(map[string]any{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "in": markWindow})
	if !hands.has("mark 300,400 500x24 30s") || !hands.has("mark 300,400 500x24 1s") {
		t.Fatalf("%v", hands.log())
	}
	if _, err := handler(map[string]any{"clear": true}); err != nil {
		t.Fatal(err)
	}
	if !hands.has("mark end") {
		t.Fatalf("the mark was not taken away: %v", hands.log())
	}
}

func TestNoMarkOverAWindowThatMovedOrOutsideItOrOverMoreThanAThing(t *testing.T) {
	handler, hands, _ := markWorld(t)
	for why, params := range map[string]map[string]any{
		// The window in front is not where the one that was looked at was.
		"moved": {"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "in": map[string]any{"x": 400.0, "y": 50.0, "w": 1200.0, "h": 800.0}},
		// Outside the window, and larger than a mark.
		"size": {"x": 5.0, "y": 400.0, "w": 500.0, "h": 24.0, "in": markWindow},
	} {
		got, err := handler(params)
		if err != nil {
			t.Fatalf("%s: %v", why, err)
		}
		if told := got.Result.(map[string]any); told["marked"] != false || told["why"] != why {
			t.Fatalf("%s: %v", why, told)
		}
	}
	got, err := handler(map[string]any{"x": 150.0, "y": 60.0, "w": 1000.0, "h": 700.0, "in": markWindow})
	if err != nil || got.Result.(map[string]any)["why"] != "size" {
		t.Fatalf("most of a window: %v %v", got, err)
	}
	if hands.has("mark ") {
		t.Fatalf("a mark was drawn all the same: %v", hands.log())
	}
}

// Where this program looks away it draws nothing, as it reads nothing.
func TestNoMarkWhereItLooksAway(t *testing.T) {
	handler, hands, _ := markWorld(t)
	screenObserversPaused.Store(true)
	defer screenObserversPaused.Store(false)
	got, err := handler(map[string]any{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "in": markWindow})
	if err != nil {
		t.Fatal(err)
	}
	if told := got.Result.(map[string]any); told["marked"] != false || told["why"] != "away" {
		t.Fatalf("with watching off: %v", told)
	}
	if hands.has("mark ") {
		t.Fatalf("a mark was drawn all the same: %v", hands.log())
	}
}

func TestAMarkRefusesWhatIsNotARectangleAndWhenThereIsNothingToDrawWith(t *testing.T) {
	handler, hands, look := markWorld(t)
	for _, bad := range []map[string]any{
		{},
		{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0},
		{"x": "300", "y": 400.0, "w": 500.0, "h": 24.0, "in": markWindow},
		{"x": 300.0, "y": 400.0, "w": 500.0, "in": markWindow},
		{"x": 1e9, "y": 400.0, "w": 500.0, "h": 24.0, "in": markWindow},
		{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "in": map[string]any{"x": 100.0}},
	} {
		if _, err := handler(bad); err == nil || !strings.Contains(err.Error(), "notch.mark") {
			t.Fatalf("%v was marked: %v", bad, err)
		}
	}
	// While the person is drawing a line, the screen is theirs.
	look.Keys(true)
	look.Down(10, 10)
	if _, err := handler(map[string]any{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "in": markWindow}); err == nil {
		t.Fatal("a mark was drawn over a line being drawn")
	}
	look.Up(10, 10)
	if hands.has("mark ") {
		t.Fatalf("%v", hands.log())
	}
	// Hands that cannot mark: the line comes without one.
	plain := newNotchLook()
	plain.Use(&fakeHands{}, func(app, title string) string { return "" }, func(map[string]any, []byte) {})
	defer plain.Forget()
	if _, err := makeNotchMarkHandler(plain)(map[string]any{"x": 300.0, "y": 400.0, "w": 500.0, "h": 24.0, "in": markWindow}); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("hands that cannot mark: %v", err)
	}
	// And taking away a mark that cannot be there is not an error.
	if _, err := makeNotchMarkHandler(plain)(map[string]any{"clear": true}); err != nil {
		t.Fatal(err)
	}
}
