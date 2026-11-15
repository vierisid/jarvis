package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
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
func (h *fakeHands) WindowRect(at lookPoint) lookRect { return lookRect{0, 0, 1800, 1000} }
func (h *fakeHands) Around(at lookPoint) []string {
	return []string{"Acme", "Payouts by customer", "", "Payouts by customer", "Payouts  -  Excel", "Sheet1"}
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
func (h *fakeHands) Point(r lookRect, label string, stay time.Duration) {
	h.note("point %d,%d %dx%d %q %v", r.X, r.Y, r.W, r.H, label, stay)
}
func (h *fakeHands) PointHit() { h.note("point hit") }
func (h *fakeHands) PointEnd() { h.note("point end") }
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

// What travelled beside a look: the words, the picture of what was circled,
// and the picture of the window round it.
func lookWords(t *testing.T, body []byte) (notchLookTold, []byte, []byte) {
	t.Helper()
	n := int(binary.BigEndian.Uint32(body))
	var told notchLookTold
	if err := json.Unmarshal(body[4:4+n], &told); err != nil {
		t.Fatal(err)
	}
	rest := body[4+n:]
	if told.PictureBytes > len(rest) {
		t.Fatalf("the words say the picture is %d bytes and %d follow", told.PictureBytes, len(rest))
	}
	return told, rest[:told.PictureBytes], rest[told.PictureBytes:]
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
	told, picture, window := lookWords(t, taken.body)
	if told.App != "excel" || len(told.Things) != 3 || told.Things[1].Name != "Lumen" || told.Things[2].Parts[1] != "430.50" {
		t.Fatalf("%+v", told)
	}
	if len(picture) < 8 || string(picture[1:4]) != "PNG" {
		t.Fatal("no picture came with it")
	}
	// What the rows stand in, the nearest first: each once, without the first
	// row's own name and without the window's title, which is told by itself.
	if !reflect.DeepEqual(told.Around, []string{"Payouts by customer", "Sheet1"}) {
		t.Fatalf("around: %q", told.Around)
	}
	// And the whole window round them, as a second picture.
	if len(window) < 8 || string(window[1:4]) != "PNG" {
		t.Fatal("no picture of the window came with it")
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
	told, _, _ := lookWords(t, taken.body)
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

func TestPointSendsThePointerToWhatTheBrainFound(t *testing.T) {
	look, hands, _, _ := lookWorld(t, "")
	handler := makeNotchPointHandler(look)
	result, err := handler(map[string]any{"x": 1880.0, "y": 4.0, "w": 32.0, "h": 24.0, "label": "  Close\n ", "ms": 4000.0})
	if err != nil || result.Result.(map[string]any)["pointed"] != true {
		t.Fatalf("%v %v", result, err)
	}
	if !hands.has(`point 1880,4 32x24 "Close" 4s`) {
		t.Fatalf("%v", hands.log())
	}
	// On a display to the left of the first, places are below zero.
	if _, err := handler(map[string]any{"x": -1500.0, "y": 300.0, "w": 80.0, "h": 20.0}); err != nil {
		t.Fatal(err)
	}
	if !hands.has(`point -1500,300 80x20 "" 5s`) {
		t.Fatalf("%v", hands.log())
	}
	// How long it stays is kept within reason.
	handler(map[string]any{"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0, "ms": 9e9})
	handler(map[string]any{"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0, "ms": 1.0})
	if !hands.has(`point 1,1 5x5 "" 15s`) || !hands.has(`point 1,1 5x5 "" 500ms`) {
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
	if hands.has("point ") && !hands.has("point end") {
		t.Fatalf("%v", hands.log())
	}
	for _, line := range hands.log() {
		if strings.HasPrefix(line, "point ") && !strings.HasPrefix(line, "point end") {
			t.Fatalf("something was pointed at: %v", hands.log())
		}
	}
}

// The owner, 16 November 2026: "it should have the little cursor that goes to the right button, waits
// until I click it, and then shows me the next step again with the cursor."
func TestPointWaitsForThePersonsClickAndSaysWhetherItWasOnTheThing(t *testing.T) {
	look, hands, _, _ := lookWorld(t, "")
	handler := makeNotchPointHandler(look)
	type answer struct {
		result map[string]any
		err    error
	}
	ask := func(params map[string]any) chan answer {
		done := make(chan answer, 1)
		go func() {
			r, err := handler(params)
			var m map[string]any
			if r != nil {
				m, _ = r.Result.(map[string]any)
			}
			done <- answer{m, err}
		}()
		return done
	}
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for i := 0; i < 400 && !ok(); i++ {
			time.Sleep(5 * time.Millisecond)
		}
		if !ok() {
			t.Fatalf("%s: %v", what, hands.log())
		}
	}
	thing := map[string]any{"x": 100.0, "y": 200.0, "w": 80.0, "h": 24.0, "label": "1. Click Add", "wait_ms": 4000.0}

	// On the thing: said so, and the ring is taken down at once.
	first := ask(thing)
	waitFor("the pointer was not sent", func() bool { return hands.has(`point 100,200 80x24 "1. Click Add"`) })
	// The pointer is watched while a click is waited for, with no key held.
	if !look.Wants() {
		t.Fatal("no click is watched for")
	}
	// The pointer moving, and the button going down, are nothing yet. Neither is kept from the app.
	look.Move(130, 210)
	if look.Down(130, 210) {
		t.Fatal("the press was kept from the app")
	}
	if look.Up(130, 210) {
		t.Fatal("the click was kept from the app")
	}
	look.Clicked(130, 210)
	got := <-first
	if got.err != nil || got.result["clicked"] != true || got.result["inside"] != true || got.result["why"] != "click" {
		t.Fatalf("%v %v", got.result, got.err)
	}
	if !hands.has("point hit") {
		t.Fatalf("the ring was left up: %v", hands.log())
	}
	if look.Wants() {
		t.Fatal("the pointer is still watched after the click")
	}

	// Just outside the thing's edge still counts: the ring is drawn out there. Further off does not.
	near := ask(thing)
	waitFor("no wait", look.Wants)
	look.Clicked(100-notchPointSlack, 200)
	if got := <-near; got.result["inside"] != true {
		t.Fatalf("%v", got.result)
	}
	off := ask(thing)
	waitFor("no wait", look.Wants)
	look.Clicked(600, 600)
	if got := <-off; got.result["clicked"] != true || got.result["inside"] != false {
		t.Fatalf("%v", got.result)
	}

	// A click on the notch itself is not a step.
	own := ask(thing)
	waitFor("no wait", look.Wants)
	hands.mu.Lock()
	hands.own = true
	hands.mu.Unlock()
	look.Clicked(130, 210)
	select {
	case got := <-own:
		t.Fatalf("a click on the notch ended the wait: %v", got.result)
	case <-time.After(60 * time.Millisecond):
	}
	hands.mu.Lock()
	hands.own = false
	hands.mu.Unlock()
	// Taken away by the brain: the wait ends, and says it was replaced.
	if _, err := handler(map[string]any{"clear": true}); err != nil {
		t.Fatal(err)
	}
	if got := <-own; got.result["clicked"] != false || got.result["why"] != "replaced" {
		t.Fatalf("%v", got.result)
	}
	if !hands.has("point end") {
		t.Fatalf("%v", hands.log())
	}

	// Nobody clicks: it gives up, and the pointer goes home.
	quiet := ask(map[string]any{"x": 100.0, "y": 200.0, "w": 80.0, "h": 24.0, "wait_ms": 40.0})
	if got := <-quiet; got.result["clicked"] != false || got.result["why"] != "time" {
		t.Fatalf("%v", got.result)
	}
	if look.Wants() {
		t.Fatal("the pointer is still watched after the wait was over")
	}

	// A new thing pointed at takes the place of the one waited on.
	old := ask(thing)
	waitFor("no wait", look.Wants)
	if _, err := handler(map[string]any{"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0}); err != nil {
		t.Fatal(err)
	}
	if got := <-old; got.result["why"] != "replaced" {
		t.Fatalf("%v", got.result)
	}
	// And so does the person beginning to draw a line.
	again := ask(thing)
	waitFor("no wait", look.Wants)
	look.Keys(true)
	look.Down(10, 10)
	if got := <-again; got.result["why"] != "replaced" {
		t.Fatalf("%v", got.result)
	}
	look.Up(10, 10)
	look.Keys(false)
}

func TestTheHandsWayIsACurveThatEndsOnTheThing(t *testing.T) {
	from, to := lookPoint{1280, 18}, lookPoint{300, 900}
	if x, y := lookHandAt(from, to, 0); x != 1280 || y != 18 {
		t.Fatalf("starts at %v,%v", x, y)
	}
	if x, y := lookHandAt(from, to, 1); x != 300 || y != 900 {
		t.Fatalf("ends at %v,%v", x, y)
	}
	// Half way through its time it has gone most of the way across and less than half the way down.
	x, y := lookHandAt(from, to, 0.5)
	across, down := (1280-x)/980, (y-18)/882
	if across < 0.7 || down > across {
		t.Fatalf("across %.2f, down %.2f", across, down)
	}
	// It never overshoots.
	for i := 0; i <= 100; i++ {
		x, y := lookHandAt(from, to, float64(i)/100)
		if x < 300-0.01 || x > 1280+0.01 || y < 18-0.01 || y > 900+0.01 {
			t.Fatalf("at %d%% it is at %v,%v", i, x, y)
		}
	}
	// A short hop is quick, a long one is not slow.
	if got := lookHandFlight(lookPoint{0, 0}, lookPoint{40, 0}); got < notchHandFlightMin || got > notchHandFlightMin+20*time.Millisecond {
		t.Fatalf("%v", got)
	}
	if got := lookHandFlight(lookPoint{0, 0}, lookPoint{5000, 3000}); got != notchHandFlightMax {
		t.Fatalf("%v", got)
	}
	// It rests inside the thing, on a button and on a thing one pixel high.
	for _, r := range []lookRect{{100, 100, 200, 40}, {100, 100, 14, 14}, {100, 100, 900, 1}} {
		if at := lookHandRest(r, 1.5); !lookGrown(r, 1).holds(at.X, at.Y) {
			t.Fatalf("on %v it rests at %v", r, at)
		}
	}
}

func TestTheHandIsACitronArrowWithItsTipWhereItSays(t *testing.T) {
	for _, scale := range []float64{1, 1.5, 2} {
		hand := newNotchHand(scale)
		if hand.w != hand.h || len(hand.pixels) != hand.w*hand.h {
			t.Fatalf("%dx%d with %d pixels", hand.w, hand.h, len(hand.pixels))
		}
		at := func(x, y float64) (a, r, g, b uint32) {
			p := hand.pixels[int(y)*hand.w+int(x)]
			return p >> 24, p >> 16 & 0xFF, p >> 8 & 0xFF, p & 0xFF
		}
		// Just inside the tip there is the dark edge; well inside the arrow, the notch's citron, solid.
		unit := notchHandBoxPx * scale / 24
		if a, _, _, _ := at(hand.tipX+0.6*unit, hand.tipY+1.2*unit); a < 200 {
			t.Fatalf("scale %v: nothing at the tip (alpha %d)", scale, a)
		}
		a, r, g, b := at(hand.tipX+5.5*unit, hand.tipY+7.5*unit)
		if a != 255 || r != notchInkR || g != notchInkG || b != notchInkB {
			t.Fatalf("scale %v: the middle of the arrow is %d %d %d %d", scale, a, r, g, b)
		}
		// The corners of its picture are clear, and no pixel is brighter than its own strength allows.
		if hand.pixels[0] != 0 || hand.pixels[len(hand.pixels)-1] != 0 {
			t.Fatalf("scale %v: the corners are not clear", scale)
		}
		for i, p := range hand.pixels {
			if a := p >> 24; p>>16&0xFF > a || p>>8&0xFF > a || p&0xFF > a {
				t.Fatalf("scale %v: pixel %d is not multiplied by its strength: %08x", scale, i, p)
			}
		}
		// Leaving the notch it is small and faint; at full size it is itself.
		frame := make([]uint32, len(hand.pixels))
		hand.frame(frame, 1, 1)
		for i := range frame {
			if frame[i] != hand.pixels[i] {
				t.Fatalf("scale %v: at full size it is not itself", scale)
			}
		}
		hand.frame(frame, notchHandSmall, 0.5)
		lit, litFull := 0, 0
		for i := range frame {
			if frame[i]>>24 > 0 {
				lit++
			}
			if hand.pixels[i]>>24 > 0 {
				litFull++
			}
			if frame[i]>>24 > 128 {
				t.Fatalf("scale %v: at half strength a pixel is stronger than half", scale)
			}
		}
		if lit == 0 || lit*3 > litFull {
			t.Fatalf("scale %v: small it covers %d pixels, full size %d", scale, lit, litFull)
		}
		hand.frame(frame, 0.5, 0)
		for i := range frame {
			if frame[i] != 0 {
				t.Fatalf("scale %v: at no strength something is seen", scale)
			}
		}
	}
}

func TestARingIsCutIntoEvenPiecesAndClosed(t *testing.T) {
	path := lookRingPath(lookRect{100, 100, 300, 40}, 6, 10)
	pieces := lookPathPieces(path, 6)
	if pieces[0] != pieces[len(pieces)-1] {
		t.Fatalf("not closed: %v ... %v", pieces[0], pieces[len(pieces)-1])
	}
	for i := 0; i+1 < len(pieces); i++ {
		if far := math.Hypot(float64(pieces[i+1].X-pieces[i].X), float64(pieces[i+1].Y-pieces[i].Y)); far > 8 {
			t.Fatalf("piece %d is %.1f long", i, far)
		}
	}
	if len(pieces) < 100 {
		t.Fatalf("only %d pieces", len(pieces))
	}
}

func TestLookEaseIsTheCurveCSSDraws(t *testing.T) {
	// Known values of cubic-bezier(.2,.7,.2,1) and of the straight line.
	if got := lookEase(0, 0, 1, 1, 0.37); math.Abs(got-0.37) > 0.001 {
		t.Fatalf("linear: %v", got)
	}
	if lookEase(0.2, 0.7, 0.2, 1, 0) != 0 || lookEase(0.2, 0.7, 0.2, 1, 1) != 1 || lookEase(0.2, 0.7, 0.2, 1, -3) != 0 || lookEase(0.2, 0.7, 0.2, 1, 7) != 1 {
		t.Fatal("the ends are not the ends")
	}
	last := 0.0
	for i := 1; i <= 50; i++ {
		got := lookEase(0.2, 0.7, 0.2, 1, float64(i)/50)
		if got < last {
			t.Fatalf("goes back at %d", i)
		}
		last = got
	}
	if early := lookEase(0.2, 0.7, 0.2, 1, 0.25); early < 0.6 {
		t.Fatalf("a quarter of the way through it is only at %.2f", early)
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
