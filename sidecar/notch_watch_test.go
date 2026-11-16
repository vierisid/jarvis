package main

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

// A key that types is never named, whatever is held with it: not a letter,
// not a digit, not a sign, not with Shift, not with AltGr. This is the line
// between "it saw that I pressed Ctrl + C" and "it saw what I wrote".
func TestWatchNeverNamesAKeyThatTypes(t *testing.T) {
	typing := []watchMods{{}, {Shift: true}, {Ctrl: true, Alt: true, AltGr: true}, {Ctrl: true, Alt: true, AltGr: true, Shift: true}}
	for vk := uint32(0x08); vk <= 0xFE; vk++ {
		if _, named := watchNamedKeys[vk]; named || (vk >= 0x70 && vk <= 0x7B) || watchIsModifier(vk) || vk == 0x1B {
			continue
		}
		for _, mods := range typing {
			if kind, spec := watchKey(vk, mods); kind == watchKeyStep || spec != "" {
				t.Fatalf("key %#x with %+v was named %q: a key that types must only be told as typing", vk, mods, spec)
			}
		}
	}
	// A sign whose key depends on the keyboard is not named even as a shortcut.
	if kind, spec := watchKey(0xBA, watchMods{Ctrl: true}); kind != watchKeyTyped || spec != "" {
		t.Fatalf("Ctrl with a sign key: got %v %q, want it told as typing", kind, spec)
	}
}

func TestWatchNamesTheKeysThatAreSteps(t *testing.T) {
	cases := []struct {
		vk   uint32
		mods watchMods
		want string
	}{
		{0x0D, watchMods{}, "enter"},
		{0x09, watchMods{}, "tab"},
		{0x09, watchMods{Shift: true}, "shift,tab"},
		{0x28, watchMods{}, "down"},
		{0x27, watchMods{Shift: true}, "shift,right"},
		{0x2E, watchMods{}, "delete"},
		{0x43, watchMods{Ctrl: true}, "ctrl,c"},
		{0x56, watchMods{Ctrl: true}, "ctrl,v"},
		{0x56, watchMods{Ctrl: true, Shift: true}, "ctrl,shift,v"},
		{0x09, watchMods{Alt: true}, "alt,tab"},
		{0x44, watchMods{Win: true}, "win,d"},
		{0x74, watchMods{}, "f5"},
		{0x31, watchMods{Ctrl: true}, "ctrl,1"},
	}
	for _, c := range cases {
		kind, spec := watchKey(c.vk, c.mods)
		if kind != watchKeyStep || spec != c.want {
			t.Errorf("key %#x with %+v: got %v %q, want a step named %q", c.vk, c.mods, kind, spec, c.want)
		}
		// What is named is what can be pressed again: the same words pass the door of notch.act.
		if !notchKeysSpec(spec, false) {
			t.Errorf("%q is named by the watch but refused by notch.act", spec)
		}
	}
	// The keys that only change other keys, and Esc, are nothing at all.
	for _, vk := range []uint32{0x10, 0x11, 0x12, 0x5B, 0xA2, 0xA5, 0x14, 0x1B} {
		if kind, spec := watchKey(vk, watchMods{Ctrl: true}); kind != watchKeyNone || spec != "" {
			t.Errorf("key %#x: got %v %q, want nothing", vk, kind, spec)
		}
	}
}

func TestWatchTellsTypingAndLookingAwayOnceEach(t *testing.T) {
	var flow watchFlow
	if !flow.Typed() || flow.Typed() || flow.Typed() {
		t.Fatal("typing is told at its first key and not again")
	}
	flow.Step()
	if !flow.Typed() {
		t.Fatal("typing after a step is a new stretch of typing")
	}
	if !flow.Away() || flow.Away() {
		t.Fatal("looking away is told once")
	}
	flow.Looking()
	if !flow.Away() {
		t.Fatal("looking away again, after looking, is told again")
	}
}

func TestClipShapeSaysHowMuchAndNeverWhat(t *testing.T) {
	row := clipShapeOf("Acme\t1200.00\tpaid\r\n")
	if row.Empty || row.Rows != 1 || row.Cols != 3 || row.Chars != len("Acme\t1200.00\tpaid") {
		t.Fatalf("a copied row: got %+v", row)
	}
	// The same row read back from the cells has no line end: it is the same thing.
	if back := clipShapeOf("Acme\t1200.00\tpaid"); back.Hash != row.Hash {
		t.Fatalf("the same row with and without its line end has two numbers: %s and %s", row.Hash, back.Hash)
	}
	if other := clipShapeOf("Acme\t1200.00\tlate"); other.Hash == row.Hash {
		t.Fatal("two different rows have the same number")
	}
	for _, nothing := range []string{"", "\r\n", "  \t ", "\n\n"} {
		if got := clipShapeOf(nothing); !got.Empty || got.Hash != "" {
			t.Fatalf("%q is nothing copied; got %+v", nothing, got)
		}
	}
	two := clipShapeOf("a\tb\nc\td\n")
	if two.Rows != 2 || two.Cols != 2 {
		t.Fatalf("two rows of two: got %+v", two)
	}
	// Nothing of the text is in what is told.
	for key, value := range row.payload() {
		if text, ok := value.(string); ok && key != "hash" {
			t.Fatalf("the shape carries a text under %q: %q", key, text)
		}
	}
	if strings.Contains(row.Hash, "Acme") {
		t.Fatal("the number of a text holds the text")
	}
}

func actParams(do string, more map[string]any) map[string]any {
	params := map[string]any{"do": do, "win": map[string]any{"id": "0x1a2b", "pid": float64(4242), "w": float64(1200), "h": float64(800)}}
	for key, value := range more {
		params[key] = value
	}
	return params
}

func TestNotchActTakesOnlyWhatAStepCanBe(t *testing.T) {
	good := []map[string]any{
		actParams("click", map[string]any{"x": float64(300), "y": float64(420), "hand": float64(1)}),
		actParams("click", map[string]any{"x": float64(300), "y": float64(420), "mods": "shift"}),
		actParams("keys", map[string]any{"keys": "ctrl,v"}),
		actParams("copy", nil),
		actParams("copy", map[string]any{"right": float64(2), "down": float64(0)}),
		{"do": "paste", "screen": true, "x": float64(900), "y": float64(500), "text": "1,291"},
		{"do": "hand", "beside": true},
		{"do": "home"},
		{"do": "front"},
		actParams("count", map[string]any{"x": float64(300), "y": float64(420), "dy": float64(22), "most": float64(60)}),
		actParams("pitch", map[string]any{"x": float64(300), "y": float64(420), "dy": float64(-22)}),
	}
	for _, params := range good {
		if _, err := parseNotchAct(params); err != nil {
			t.Errorf("%v was refused: %v", params, err)
		}
	}
	bad := []map[string]any{
		{"do": "type"},
		{"do": "click", "x": float64(1), "y": float64(1)}, // a place in no window
		actParams("click", map[string]any{"x": float64(300)}),
		actParams("click", map[string]any{"x": float64(300), "y": float64(420), "hand": float64(3)}),
		actParams("click", map[string]any{"x": float64(300), "y": float64(420), "mods": "ctrl,c"}),
		actParams("keys", map[string]any{"keys": "a"}),             // a letter alone is typing
		actParams("keys", map[string]any{"keys": "ctrl,c,ctrl,v"}), // one key at a time
		actParams("keys", map[string]any{"keys": "ctrl+c"}),
		actParams("keys", map[string]any{"keys": ""}),
		actParams("copy", map[string]any{"right": float64(5000)}),
		actParams("count", map[string]any{"x": float64(300), "y": float64(420), "most": float64(60)}), // no way on
		actParams("count", map[string]any{"x": float64(300), "y": float64(420), "dy": float64(22)}),   // no most
		{"do": "keys", "keys": "ctrl,v"},                                                              // keys in no window
		{"do": "paste", "screen": true, "x": float64(1), "y": float64(1)},
		{"do": "click", "x": float64(1), "y": float64(1), "win": map[string]any{"id": "notepad", "pid": float64(1)}},
		{"do": "click", "x": float64(1), "y": float64(1), "win": map[string]any{"id": "0x1a", "pid": float64(0)}},
	}
	for _, params := range bad {
		if _, err := parseNotchAct(params); err == nil {
			t.Errorf("%v was taken", params)
		}
	}
}

func TestNotchActKeysAreOnlyNamedKeysAndShortcuts(t *testing.T) {
	for _, spec := range []string{"enter", "shift,down", "ctrl,c", "ctrl,shift,v", "alt,tab", "f5", "win,d", "delete", "ctrl,backspace"} {
		if !notchKeysSpec(spec, false) {
			t.Errorf("%q was refused", spec)
		}
	}
	// A letter, a digit, Space or Backspace alone, or with Shift only, is typing: never pressed as a step.
	for _, spec := range []string{"", "a", "shift,a", "7", "space", "backspace", "shift,a,b", "ctrl", "f0", "f13", "f05", "ctrl,é", "escape", "ctrl,;", "hello"} {
		if notchKeysSpec(spec, false) {
			t.Errorf("%q was taken", spec)
		}
	}
	if !notchKeysSpec("", true) || !notchKeysSpec("ctrl,shift", true) || notchKeysSpec("ctrl,c", true) {
		t.Error("what is held with a click is only the keys that change other keys")
	}
}

func TestNotchActPlaceRefusesAWindowThatIsNotAsItWas(t *testing.T) {
	act, err := parseNotchAct(actParams("click", map[string]any{"x": float64(300), "y": float64(420)}))
	if err != nil {
		t.Fatal(err)
	}
	// The window has moved: the place moves with it.
	at, placeErr := notchActPlace(act, lookRect{100, 50, 1200, 800})
	if placeErr != nil || at != (lookPoint{400, 470}) {
		t.Fatalf("a window that only moved: got %v, %v", at, placeErr)
	}
	why := func(err error) string {
		var refusal *notchActError
		if !errors.As(err, &refusal) {
			t.Fatalf("not a refusal: %v", err)
		}
		return refusal.Why
	}
	// It is another size: what was at that place is somewhere else now.
	if _, err := notchActPlace(act, lookRect{100, 50, 1000, 800}); err == nil || why(err) != "moved" {
		t.Fatalf("a window of another size: got %v", err)
	}
	if _, err := notchActPlace(act, lookRect{}); err == nil || why(err) != "gone" {
		t.Fatalf("no window: got %v", err)
	}
	outside, _ := parseNotchAct(actParams("click", map[string]any{"x": float64(300), "y": float64(900)}))
	if _, err := notchActPlace(outside, lookRect{100, 50, 1200, 800}); err == nil || why(err) != "outside" {
		t.Fatalf("a place below the window: got %v", err)
	}
	// A place on the screen is taken as it is.
	screen, _ := parseNotchAct(map[string]any{"do": "paste", "screen": true, "x": float64(900), "y": float64(500), "text": "x"})
	if at, err := notchActPlace(screen, lookRect{}); err != nil || at != (lookPoint{900, 500}) {
		t.Fatalf("a place on the screen: got %v, %v", at, err)
	}
}

func TestAHopIsQuickerThanTheWayOutOfTheNotch(t *testing.T) {
	near := lookHandHop(lookPoint{500, 400}, lookPoint{500, 428})
	far := lookHandHop(lookPoint{100, 100}, lookPoint{1800, 900})
	if near < 120 || near > 200 {
		t.Errorf("a hop to the next row takes %d ms", near)
	}
	if far > 420 || far <= near {
		t.Errorf("a hop across the screen takes %d ms", far)
	}
	if time.Duration(far)*time.Millisecond >= notchHandFlightMin {
		t.Errorf("a hop (%d ms) is not quicker than the way out of the notch (%s)", far, notchHandFlightMin)
	}
}

// With the talk keys down and a thing held, the words "Put ... here" stand
// beside the pointer over a place that can take it, and nowhere else.
func TestLookSaysPutItHereOnlyOverAPlaceThatTakesIt(t *testing.T) {
	look, hands, _, _ := lookWorld(t, "")
	hovered := func() bool { return hands.has("hover Put 3 rows here") }
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("%s; done: %v", what, hands.log())
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	read := func(at string) func() bool { return func() bool { return hands.has("thing at " + at) } }

	// Nothing is held: the pointer is not read at all.
	look.Keys(true)
	look.Move(300, 300)
	time.Sleep(80 * time.Millisecond)
	if hands.has("thing at") {
		t.Fatalf("with nothing held the place under the pointer was read: %v", hands.log())
	}

	look.Hold("3 rows", time.Minute)
	// Over a button: read, and nothing said.
	hands.mu.Lock()
	hands.at = lookThing{Kind: "button", Role: "Button", Name: "Send"}
	hands.mu.Unlock()
	look.Move(310, 300)
	waitFor("the place under the pointer was not read", read("310,300"))
	time.Sleep(40 * time.Millisecond)
	if hovered() {
		t.Fatalf("\"Put it here\" was said over a button: %v", hands.log())
	}
	// Over a field: said.
	hands.mu.Lock()
	hands.at = lookThing{Kind: "field", Role: "Edit"}
	hands.mu.Unlock()
	time.Sleep(notchLookTagEvery)
	look.Move(500, 420)
	waitFor("nothing was said over a field", hovered)

	// With the keys up the pointer is nobody's: moving it reads nothing.
	look.Keys(false)
	before := len(hands.log())
	look.Move(600, 500)
	time.Sleep(80 * time.Millisecond)
	for _, line := range hands.log()[before:] {
		if strings.HasPrefix(line, "thing at") {
			t.Fatalf("with the keys up the place under the pointer was read: %v", hands.log()[before:])
		}
	}
}

func TestLookForgetsWhatItHeldWhenItsTimeIsUp(t *testing.T) {
	look, hands, _, _ := lookWorld(t, "")
	hands.mu.Lock()
	hands.at = lookThing{Kind: "field", Role: "Edit"}
	hands.mu.Unlock()
	look.Hold("1,291", 30*time.Millisecond)
	time.Sleep(60 * time.Millisecond)
	look.Keys(true)
	look.Move(500, 420)
	time.Sleep(notchLookTagEvery + 80*time.Millisecond)
	if hands.has("hover") {
		t.Fatalf("a thing held past its time was still offered: %v", hands.log())
	}
}

func TestLookSaysNothingOverAPlaceItLooksAwayFrom(t *testing.T) {
	look, hands, _, _ := lookWorld(t, "bank")
	hands.mu.Lock()
	hands.at = lookThing{Kind: "field", Role: "Edit"}
	hands.mu.Unlock()
	look.Hold("1,291", time.Minute)
	look.Keys(true)
	look.Move(500, 420)
	time.Sleep(notchLookTagEvery + 80*time.Millisecond)
	if hands.has("thing at") || hands.has("hover") {
		t.Fatalf("a place this program looks away from was read: %v", hands.log())
	}
}

func TestWhatTakesAThing(t *testing.T) {
	for _, thing := range []lookThing{{Kind: "field"}, {Kind: "cell"}, {Kind: "thing", Role: "Document"}, {Kind: "thing", Role: "DataItem"}} {
		if !lookTakes(thing) {
			t.Errorf("%+v does not take a thing", thing)
		}
	}
	for _, thing := range []lookThing{{Kind: "button", Role: "Button"}, {Kind: "link"}, {Kind: "text", Role: "Text"}, {Kind: "picture"}, {}} {
		if lookTakes(thing) {
			t.Errorf("%+v takes a thing", thing)
		}
	}
}

func TestCountingWhatIsLeftStopsAtTheFirstEmptyOne(t *testing.T) {
	row := func(y int, value string) lookThing {
		return lookThing{Kind: "cell", Role: "DataItem", Name: "A", Value: value, Rect: lookRect{100, y, 200, 20}}
	}
	// Five rows with something in them after the one in hand, then an empty one, then more.
	sheet := func(k int) (lookThing, bool) {
		if k <= 5 {
			return row(100+20*k, "x"), true
		}
		if k == 6 {
			return row(100+20*k, ""), true
		}
		return row(100+20*k, "later"), true
	}
	if left, known := watchCountLeft(sheet, 50); !known || left != 5 {
		t.Fatalf("got %d, known %v; want 5 and known", left, known)
	}
	// Never more than it was asked to count.
	if left, known := watchCountLeft(sheet, 3); !known || left != 3 {
		t.Fatalf("with a most of 3: got %d, known %v", left, known)
	}
	// A cell's name is only its place: a cell with a name and nothing in it is empty.
	named := func(k int) (lookThing, bool) {
		return lookThing{Kind: "cell", Role: "DataItem", Name: "B7", Rect: lookRect{100, 100 + 20*k, 200, 20}}, true
	}
	if left, known := watchCountLeft(named, 50); !known || left != 0 {
		t.Fatalf("empty cells that have names: got %d, known %v", left, known)
	}
	// A list ends where another kind of thing begins.
	list := func(k int) (lookThing, bool) {
		if k <= 2 {
			return lookThing{Kind: "row", Role: "ListItem", Name: "a file", Rect: lookRect{0, 30 * k, 400, 30}}, true
		}
		return lookThing{Kind: "thing", Role: "Pane", Rect: lookRect{0, 0, 400, 900}}, true
	}
	if left, known := watchCountLeft(list, 50); !known || left != 2 {
		t.Fatalf("a list of three: got %d, known %v", left, known)
	}
}

func TestCountingSaysWhenItCannotTell(t *testing.T) {
	// A window that draws its own rows describes one large thing: every place holds the same one.
	canvas := func(k int) (lookThing, bool) {
		return lookThing{Kind: "thing", Role: "Document", Name: "a sheet", Rect: lookRect{0, 0, 1600, 900}}, true
	}
	if left, known := watchCountLeft(canvas, 50); known || left != 0 {
		t.Fatalf("one large thing: got %d, known %v; want it not to know", left, known)
	}
	nothing := func(k int) (lookThing, bool) { return lookThing{}, false }
	if _, known := watchCountLeft(nothing, 50); known {
		t.Fatal("nothing there at all, and it says it knows")
	}
}

// A strip of a sheet as the screen shows it: white rows with a grey line
// between them, `pitch` pixels apart. The pitch need not be a whole number:
// at 125% and 150% display scaling it is not.
func gridProfile(height int, pitch float64, phase float64) []float64 {
	profile := make([]float64, height)
	for y := range profile {
		profile[y] = 250
		// How near this pixel row is to a grid line.
		off := math.Mod(float64(y)+phase, pitch)
		if off < 1 {
			profile[y] = 250 - 60*(1-off)
		} else if pitch-off < 1 {
			profile[y] = 250 - 60*(1-(pitch-off))
		}
	}
	return profile
}

// The fault this measuring exists for: two clicks by hand on two rows are
// not one row apart, and going on by their distance lands in the wrong row.
func TestTheRealDistanceBetweenRowsIsFoundFromTheScreenNotFromTheHand(t *testing.T) {
	for _, pitch := range []float64{20, 21, 24, 26.25, 31.5, 17.5} {
		profile := gridProfile(int(pitch*20), pitch, 3)
		// The hand was up to seven pixels out, either way.
		for _, wobble := range []float64{-7, -3, 0, 4, 7} {
			got, ok := watchPitch(profile, pitch+wobble)
			if !ok {
				t.Fatalf("rows %.2f apart, clicks %.2f apart: no rows were seen", pitch, pitch+wobble)
			}
			if math.Abs(got-pitch) > 0.06 {
				t.Fatalf("rows %.2f apart, clicks %.2f apart: measured %.3f", pitch, pitch+wobble, got)
			}
			// Twenty rows on, the click is still in its row: less than a quarter of a row out.
			if drift := math.Abs(got-pitch) * 20; drift > pitch/4 {
				t.Fatalf("rows %.2f apart: twenty rows on it is %.1f pixels out", pitch, drift)
			}
			// What going on by the hand's own distance would have done.
			if wobble == 7 && (pitch+wobble)*20-pitch*20 < pitch {
				t.Fatalf("the test is too easy: the hand's own distance would have stayed in the row")
			}
		}
	}
}

func TestSkippingRowsIsAWholeNumberOfThem(t *testing.T) {
	profile := gridProfile(21*30, 21, 0)
	// Every other row, and every third.
	for rows, clicks := range map[float64]float64{2: 45, 3: 60} {
		got, ok := watchPitch(profile, clicks)
		if !ok || math.Abs(got-rows*21) > 0.2 {
			t.Fatalf("clicks %.0f apart on rows 21 apart: got %.2f, %v; want %.0f rows", clicks, got, ok, rows)
		}
	}
	// Going up is the same distance.
	if got, ok := watchPitch(profile, -19); !ok || math.Abs(got-21) > 0.1 {
		t.Fatalf("going up: got %.2f, %v", got, ok)
	}
}

func TestWhereNoRowsCanBeSeenItSaysSo(t *testing.T) {
	blank := make([]float64, 500)
	for i := range blank {
		blank[i] = 255
	}
	if _, ok := watchPitch(blank, 22); ok {
		t.Fatal("a blank strip has rows")
	}
	// A picture: bright and dark with no evenness to it.
	noise := make([]float64, 500)
	seed := uint32(7)
	for i := range noise {
		seed = seed*1664525 + 1013904223
		noise[i] = float64(seed >> 24)
	}
	if got, ok := watchPitch(noise, 22); ok {
		t.Fatalf("a strip with no rows in it was measured as rows %.2f apart", got)
	}
	// Too short a strip to be sure of.
	if _, ok := watchPitch(gridProfile(60, 21, 0), 21); ok {
		t.Fatal("three rows were enough to measure by")
	}
	// What the person did does not fit the rows that are there: half a row on.
	if got, ok := watchPitch(gridProfile(40*20, 40, 0), 60); ok {
		t.Fatalf("a row and a half was taken for a whole number of rows: %.2f", got)
	}
	// A hand that barely moved is not a step.
	if _, ok := watchPitch(gridProfile(400, 21, 0), 3); ok {
		t.Fatal("three pixels were taken for a step")
	}
}

func TestLinesOfWritingAreRowsToo(t *testing.T) {
	// No grid: line after line of writing, each a darker band with a gap under it. The lines differ.
	const pitch = 19
	profile := make([]float64, pitch*24)
	seed := uint32(3)
	for line := 0; line < 24; line++ {
		seed = seed*1664525 + 1013904223
		ink := 120 + float64(seed>>27) // each line is a little darker or lighter than the next
		for y := 0; y < pitch; y++ {
			v := 255.0
			if y >= 4 && y < 15 {
				v = ink
			}
			profile[line*pitch+y] = v
		}
	}
	got, ok := watchPitch(profile, 24)
	if !ok || math.Abs(got-pitch) > 0.1 {
		t.Fatalf("lines of writing 19 apart: got %.2f, %v", got, ok)
	}
}

func TestAStripIsReadAsHowBrightEachRowIs(t *testing.T) {
	// Two pixel rows of three: white, then mid grey.
	pixels := []uint32{0xffffff, 0xffffff, 0xffffff, 0x808080, 0x808080, 0x808080}
	got := watchProfile(pixels, 3, 2)
	if len(got) != 2 || math.Abs(got[0]-255) > 0.01 || math.Abs(got[1]-128) > 0.01 {
		t.Fatalf("got %v", got)
	}
	if watchProfile(pixels, 4, 2) != nil || watchProfile(nil, 0, 0) != nil {
		t.Fatal("a strip that is not there was read")
	}
}

func TestTheStripStaysInsideTheWindow(t *testing.T) {
	win := lookRect{100, 50, 800, 600}
	// Going down: a little above the click, a long way below it.
	down := watchStrip(win, lookPoint{400, 200}, 21)
	if down.Y != 200-4*21 || down.Y+down.H != 200+16*21 || down.X != 310 || down.W != 180 {
		t.Fatalf("going down: %+v", down)
	}
	// Near the edges it is cut to the window.
	corner := watchStrip(win, lookPoint{120, 620}, 21)
	if corner.X != 100 || corner.Y+corner.H != 650 || corner.W != 110 {
		t.Fatalf("near the corner: %+v", corner)
	}
	up := watchStrip(win, lookPoint{400, 500}, -21)
	if up.Y != 500-16*21 || up.Y+up.H != 500+4*21 {
		t.Fatalf("going up: %+v", up)
	}
	if got := watchStrip(win, lookPoint{2000, 2000}, 21); !got.empty() {
		t.Fatalf("a place outside the window: %+v", got)
	}
}
