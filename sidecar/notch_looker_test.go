package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHands is a platform that draws nothing and reads what it is told to.
type fakeHands struct {
	mu      sync.Mutex
	did     []string
	own     bool
	slow    time.Duration // how long the press takes to find out where it is
	things  []lookThing
	at      lookThing
	watches int
}

func (h *fakeHands) note(format string, args ...any) {
	h.mu.Lock()
	h.did = append(h.did, fmt.Sprintf(format, args...))
	h.mu.Unlock()
}

func (h *fakeHands) log() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.did...)
}

func (h *fakeHands) has(prefix string) bool {
	for _, line := range h.log() {
		if strings.HasPrefix(line, prefix) {
			return true
		}
	}
	return false
}

func (h *fakeHands) Watch() { h.mu.Lock(); h.watches++; h.mu.Unlock() }
func (h *fakeHands) Screen(at lookPoint) (lookRect, float64) {
	time.Sleep(h.slow)
	return lookRect{0, 0, 1920, 1080}, 1.5
}
func (h *fakeHands) Own(at lookPoint) bool { return h.own }
func (h *fakeHands) Front(at lookPoint) (string, string) {
	return "excel", "Payouts  -  Excel"
}
func (h *fakeHands) Snapshot(screen lookRect) lookSnapshot {
	h.note("snapshot")
	return &lookShot{pixels: make([]byte, screen.W*screen.H*4), w: screen.W, h: screen.H}
}
func (h *fakeHands) InkBegin(at lookPoint, screen lookRect, scale float64) {
	h.note("ink begin %d,%d x%.1f", at.X, at.Y, scale)
}
func (h *fakeHands) InkLine(from, to lookPoint) { h.note("ink line") }
func (h *fakeHands) InkTag(text string, bounds lookRect) {
	h.note("ink tag %s", text)
}
func (h *fakeHands) InkEnd(stay time.Duration) { h.note("ink end %v", stay) }
func (h *fakeHands) Ring(r lookRect, label string, stay time.Duration) {
	h.note("ring %d,%d %dx%d %q %v", r.X, r.Y, r.W, r.H, label, stay)
}
func (h *fakeHands) ThingAt(at lookPoint, light bool) (lookThing, bool) {
	h.note("thing at %d,%d light=%v", at.X, at.Y, light)
	return h.at, h.at.Kind != ""
}
func (h *fakeHands) ThingsIn(line []lookPoint, light bool) []lookThing {
	h.note("things in light=%v", light)
	return append([]lookThing(nil), h.things...)
}

type lookSent struct {
	payload map[string]any
	body    []byte
}

func lookWorld(t *testing.T, away string) (*NotchLook, *fakeHands, func(phase string) lookSent, func() []lookSent) {
	t.Helper()
	hands := &fakeHands{}
	var mu sync.Mutex
	var all []lookSent
	arrived := make(chan struct{}, 64)
	look := newNotchLook()
	look.Use(hands, func(app, title string) string { return away }, func(payload map[string]any, body []byte) {
		mu.Lock()
		all = append(all, lookSent{payload, body})
		mu.Unlock()
		arrived <- struct{}{}
	})
	t.Cleanup(look.Forget)
	sent := func() []lookSent {
		mu.Lock()
		defer mu.Unlock()
		return append([]lookSent(nil), all...)
	}
	// Waits for an event of that phase and gives it back.
	wait := func(phase string) lookSent {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			for _, event := range sent() {
				if event.payload["phase"] == phase {
					return event
				}
			}
			select {
			case <-arrived:
			case <-deadline:
				t.Fatalf("no %q was told; told: %v, done: %v", phase, sent(), hands.log())
			}
		}
	}
	return look, hands, wait, sent
}

func lookWords(t *testing.T, body []byte) (notchLookTold, []byte) {
	t.Helper()
	n := int(binary.BigEndian.Uint32(body))
	var told notchLookTold
	if err := json.Unmarshal(body[4:4+n], &told); err != nil {
		t.Fatal(err)
	}
	return told, body[4+n:]
}

func TestLookALineRoundThreeRowsIsToldWithWhatItHeldAndAPicture(t *testing.T) {
	look, hands, wait, _ := lookWorld(t, "")
	hands.things = []lookThing{
		{Kind: "row", Name: "Acme", Parts: []string{"Acme", "120"}, Rect: lookRect{100, 200, 900, 24}},
		{Kind: "row", Name: "Lumen", Parts: []string{"Lumen", "740.50"}, Rect: lookRect{100, 224, 900, 24}},
		{Kind: "row", Name: "Northwind", Parts: []string{"Northwind", "430.50"}, Rect: lookRect{100, 248, 900, 24}},
	}
	look.Keys(true)
	if !look.Wants() {
		t.Fatal("with the pair down the pointer is not watched")
	}
	if !look.Down(120, 205) {
		t.Fatal("the press reached the app")
	}
	begun := wait("begun")
	for _, p := range lookRing(250, 236, 150, 44, 30) {
		look.Move(p.X, p.Y)
	}
	if !look.Up(121, 206) {
		t.Fatal("the letting go reached the app")
	}
	taken := wait("taken")
	if taken.payload["look_id"] != begun.payload["look_id"] || taken.payload["how"] != "loop" || taken.payload["things"] != 3 {
		t.Fatalf("%v", taken.payload)
	}
	told, picture := lookWords(t, taken.body)
	if told.App != "excel" || len(told.Things) != 3 || told.Things[1].Name != "Lumen" || told.Things[2].Parts[1] != "430.50" {
		t.Fatalf("%+v", told)
	}
	if len(picture) < 8 || string(picture[1:4]) != "PNG" {
		t.Fatal("no picture came with it")
	}
	// Where the picture is: round the rows that were found, not only round the line.
	part := taken.payload["picture"].(map[string]any)
	if part["w"].(int) < 900 {
		t.Fatalf("the picture does not show the whole rows: %v", part)
	}
	log := hands.log()
	// The copy of the screen is taken before any ink is on it.
	if log[0] != "snapshot" || log[1] != "ink begin 120,205 x1.5" {
		t.Fatalf("%v", log)
	}
	if !hands.has("ink line") || !hands.has("ink tag 3 rows") || !hands.has("ink end 900ms") {
		t.Fatalf("%v", log)
	}
	// The last reading is the full one.
	if !hands.has("things in light=false") {
		t.Fatalf("%v", log)
	}
}

func TestLookAClickIsTheOneThingUnderThePointer(t *testing.T) {
	look, hands, wait, _ := lookWorld(t, "")
	hands.at = lookThing{Kind: "button", Role: "Button", Name: "Close", Rect: lookRect{1880, 4, 32, 24}}
	look.Keys(true)
	look.Down(1890, 12)
	look.Up(1891, 12)
	taken := wait("taken")
	if taken.payload["how"] != "click" || taken.payload["things"] != 1 {
		t.Fatalf("%v", taken.payload)
	}
	told, _ := lookWords(t, taken.body)
	if told.Things[0].Name != "Close" || told.Things[0].Kind != "button" {
		t.Fatalf("%+v", told)
	}
	if !hands.has("thing at 1891,12 light=false") || hands.has("things in") {
		t.Fatalf("%v", hands.log())
	}
}

func TestLookWithoutTheKeysThePointerIsTheApps(t *testing.T) {
	look, hands, _, sent := lookWorld(t, "")
	if look.Wants() {
		t.Fatal("the pointer is watched with no key down")
	}
	if look.Down(10, 10) || look.Up(10, 10) {
		t.Fatal("a click without the keys was taken")
	}
	look.Move(50, 50)
	time.Sleep(30 * time.Millisecond)
	if len(sent()) != 0 || len(hands.log()) != 0 {
		t.Fatalf("something was done: %v %v", sent(), hands.log())
	}
}

func TestLookAPressOnOneOfItsOwnWindowsIsThatWindows(t *testing.T) {
	look, hands, _, sent := lookWorld(t, "")
	hands.own = true
	look.Keys(true)
	if look.Down(960, 10) {
		t.Fatal("a press on the notch was taken from it")
	}
	if look.Up(960, 10) {
		t.Fatal("its letting go was taken")
	}
	time.Sleep(30 * time.Millisecond)
	if len(sent()) != 0 {
		t.Fatalf("%v", sent())
	}
}

// Decided here before anything is read (notch_where.go): a bank, a password,
// an app on the person's list.
func TestLookWhereThisProgramLooksAwayNothingIsReadAndThePressIsStillKept(t *testing.T) {
	look, hands, wait, _ := lookWorld(t, "bank")
	hands.things = []lookThing{{Kind: "row", Name: "Balance", Rect: lookRect{0, 0, 10, 10}}}
	look.Keys(true)
	if !look.Down(100, 100) {
		t.Fatal("the press reached the bank's page")
	}
	for _, p := range lookRing(300, 300, 150, 60, 30) {
		look.Move(p.X, p.Y)
	}
	time.Sleep(250 * time.Millisecond) // the tag would have been read by now
	if !look.Up(100, 101) {
		t.Fatal("the letting go reached the bank's page")
	}
	taken := wait("taken")
	if taken.payload["refused"] != "bank" || taken.body != nil {
		t.Fatalf("%v, %d bytes", taken.payload, len(taken.body))
	}
	if _, has := taken.payload["things"]; has {
		t.Fatal("a look that was refused says what it held")
	}
	for _, line := range hands.log() {
		if line == "snapshot" || strings.HasPrefix(line, "thing") {
			t.Fatalf("something was read or copied: %v", hands.log())
		}
	}
}

// A click is quicker than finding out which window it was on.
func TestLookAQuickClickWaitsForTheLookAwayCheck(t *testing.T) {
	look, hands, wait, _ := lookWorld(t, "password")
	hands.slow = 120 * time.Millisecond
	hands.at = lookThing{Kind: "field", Name: "Password", Rect: lookRect{0, 0, 10, 10}}
	look.Keys(true)
	look.Down(100, 100)
	look.Up(100, 100)
	taken := wait("taken")
	if taken.payload["refused"] != "password" {
		t.Fatalf("a click made before the check finished was read: %v", taken.payload)
	}
	if hands.has("thing at") || hands.has("snapshot") {
		t.Fatalf("%v", hands.log())
	}
}

func TestLookEscHalfWayThroughACircleAndNothingHappens(t *testing.T) {
	look, hands, wait, sent := lookWorld(t, "")
	hands.things = []lookThing{{Kind: "row", Name: "Acme", Rect: lookRect{0, 0, 10, 10}}}
	look.Keys(true)
	// Esc with no line is not the look's.
	if look.Esc() {
		t.Fatal("Esc with nothing drawn was taken")
	}
	look.Down(100, 100)
	begun := wait("begun")
	look.Move(200, 100)
	look.Move(200, 200)
	if !look.Esc() {
		t.Fatal("Esc did not throw the line away")
	}
	// The key repeating while held, and its coming up, reach no app either.
	if !look.Esc() || !look.EscUp() || look.EscUp() {
		t.Fatal("the rest of that Esc was not the look's")
	}
	dropped := wait("dropped")
	if dropped.payload["look_id"] != begun.payload["look_id"] {
		t.Fatalf("%v", dropped.payload)
	}
	// The button comes up: kept from the app, and nothing is told.
	if !look.Up(200, 200) {
		t.Fatal("the letting go after Esc reached the app")
	}
	time.Sleep(300 * time.Millisecond)
	for _, event := range sent() {
		if event.payload["phase"] == "taken" {
			t.Fatal("a line that was thrown away was told")
		}
	}
	if !hands.has("ink end 120ms") {
		t.Fatalf("the ink was not taken away: %v", hands.log())
	}
}

func TestLookTheTagIsReadWhileTheLineIsDrawn(t *testing.T) {
	look, hands, wait, _ := lookWorld(t, "")
	hands.things = []lookThing{{Kind: "row", Name: "Acme", Rect: lookRect{0, 0, 10, 10}}, {Kind: "row", Name: "Lumen", Rect: lookRect{0, 20, 10, 10}}}
	look.Keys(true)
	look.Down(100, 100)
	wait("begun")
	deadline := time.Now().Add(2 * time.Second)
	for i := 0; !hands.has("ink tag 2 rows") && time.Now().Before(deadline); i++ {
		p := lookRing(300, 300, 150, 60, 400)[i%400]
		look.Move(p.X, p.Y)
		time.Sleep(5 * time.Millisecond)
	}
	if !hands.has("ink tag 2 rows") {
		t.Fatalf("no tag while drawing: %v", hands.log())
	}
	// For the tag, only what the tag needs is read.
	if !hands.has("things in light=true") || hands.has("things in light=false") {
		t.Fatalf("%v", hands.log())
	}
	look.Up(100, 100)
	wait("taken")
}

func TestLookThePointerIsWatchedOnlyWhileTheKeysAreDownOrALineIsDrawn(t *testing.T) {
	look, hands, wait, _ := lookWorld(t, "")
	hands.at = lookThing{Kind: "button", Name: "OK", Rect: lookRect{0, 0, 10, 10}}
	look.Keys(true)
	look.Down(10, 10)
	// The keys come up first: the line is still the look's until the button is up.
	look.Keys(false)
	if !look.Wants() {
		t.Fatal("the pointer was let go with the button still down")
	}
	look.Up(10, 10)
	if look.Wants() {
		t.Fatal("the pointer is still watched with nothing held")
	}
	wait("taken")
	hands.mu.Lock()
	watches := hands.watches
	hands.mu.Unlock()
	// Asked to look again each time what it wants changed: keys down, keys up, button up.
	if watches < 3 {
		t.Fatalf("the platform was asked %d times", watches)
	}
}

func TestLookForgottenItTakesNothingAndTellsNothing(t *testing.T) {
	look, hands, _, sent := lookWorld(t, "")
	look.Keys(true)
	look.Down(10, 10)
	look.Forget()
	if look.Wants() {
		t.Fatal("the pointer is still watched")
	}
	// The pair is still down, but there is nobody to tell.
	look.Keys(true)
	if look.Down(20, 20) {
		t.Fatal("a press was taken with no brain to tell")
	}
	time.Sleep(50 * time.Millisecond)
	for _, event := range sent() {
		if event.payload["phase"] == "taken" {
			t.Fatal("a look was told after it was forgotten")
		}
	}
	_ = hands
}

func TestPointDrawsARingRoundWhatTheBrainFound(t *testing.T) {
	look, hands, _, _ := lookWorld(t, "")
	handler := makeNotchPointHandler(look)
	result, err := handler(map[string]any{"x": 1880.0, "y": 4.0, "w": 32.0, "h": 24.0, "label": "  Close\n ", "ms": 4000.0})
	if err != nil || result.Result.(map[string]any)["pointed"] != true {
		t.Fatalf("%v %v", result, err)
	}
	if !hands.has(`ring 1880,4 32x24 "Close" 4s`) {
		t.Fatalf("%v", hands.log())
	}
	// On a display to the left of the first, places are below zero.
	if _, err := handler(map[string]any{"x": -1500.0, "y": 300.0, "w": 80.0, "h": 20.0}); err != nil {
		t.Fatal(err)
	}
	if !hands.has(`ring -1500,300 80x20 "" 5s`) {
		t.Fatalf("%v", hands.log())
	}
	// How long it stays is kept within reason.
	handler(map[string]any{"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0, "ms": 9e9})
	handler(map[string]any{"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0, "ms": 1.0})
	if !hands.has(`ring 1,1 5x5 "" 15s`) || !hands.has(`ring 1,1 5x5 "" 500ms`) {
		t.Fatalf("%v", hands.log())
	}
}

func TestPointRefusesWhatIsNotARectangleAndWhenThereIsNothingToDrawWith(t *testing.T) {
	look, hands, _, _ := lookWorld(t, "")
	handler := makeNotchPointHandler(look)
	for _, bad := range []map[string]any{
		{},
		{"x": 1.0, "y": 1.0, "w": 0.0, "h": 5.0},
		{"x": "1", "y": 1.0, "w": 5.0, "h": 5.0},
		{"x": 1.0, "y": 1.0, "w": 5.0},
		{"x": 1e9, "y": 1.0, "w": 5.0, "h": 5.0},
	} {
		if _, err := handler(bad); err == nil {
			t.Fatalf("%v was pointed at", bad)
		}
	}
	// While the person is drawing a line, the screen is theirs.
	look.Keys(true)
	look.Down(10, 10)
	if _, err := handler(map[string]any{"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0}); err == nil {
		t.Fatal("a ring was drawn over a line being drawn")
	}
	look.Up(10, 10)
	look.Forget()
	if _, err := handler(map[string]any{"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0}); err == nil {
		t.Fatal("a ring was drawn with nothing to draw with")
	}
	if hands.has("ring") {
		t.Fatalf("%v", hands.log())
	}
}

// The person's "stop looking" covers every way Jarvis looks: with watching
// switched off, or Jarvis asleep, a circle reads nothing.
func TestLookAwayWhileWatchingIsSwitchedOff(t *testing.T) {
	was := screenObserversPaused.Load()
	defer screenObserversPaused.Store(was)
	screenObserversPaused.Store(false)
	if got := notchLookAway("notepad", "notes.txt - Notepad"); got != "" {
		t.Fatalf("looking away from a plain window: %q", got)
	}
	screenObserversPaused.Store(true)
	if got := notchLookAway("notepad", "notes.txt - Notepad"); got != "off" {
		t.Fatalf("with watching off: %q", got)
	}
}
