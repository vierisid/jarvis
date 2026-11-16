package main

import (
	"errors"
	"fmt"
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

// madeSheet paints a strip of a made-up sheet the way a screen shows one:
// rows with a thin line under each, words of different lengths in them, and
// the things that are in a real sheet and do not repeat: a heading over the
// rows that is not on their grid, rows with a fill that hides the lines
// between them, a row that is selected. Rows need not be a whole number of
// pixels apart: at 125% and 150% display scaling they are not.
type madeSheet struct {
	width, height int
	pitch         float64
	// Where the first row begins, in pixels from the top. Above it is a heading.
	top int
	// No lines between the rows: only the words in them.
	bare bool
	// Rows whose fill hides the line under them (the row and the next share it).
	filled func(row int) bool
	// The row that is selected, or -1.
	selected int
	// Light lines on a dark window.
	dark bool
	// Every other row a shade darker, and no lines.
	striped bool
	seed    uint32
}

func (m madeSheet) pixels() []uint32 {
	paper, line, ink := uint32(0xffffff), uint32(0xe2e2e2), uint32(0x202124)
	if m.dark {
		paper, line, ink = 0x1e1e1e, 0x2b2b2b, 0xd4d4d4
	}
	out := make([]uint32, m.width*m.height)
	for i := range out {
		out[i] = paper
	}
	set := func(x, y int, colour uint32) {
		if x >= 0 && x < m.width && y >= 0 && y < m.height {
			out[y*m.width+x] = colour
		}
	}
	hash := func(a, b, c int) uint32 {
		h := m.seed + uint32(a)*2654435761 + uint32(b)*40503 + uint32(c)*2246822519
		h ^= h >> 15
		h *= 2246822519
		h ^= h >> 13
		return h
	}
	// The heading: a bar, a thicker line, and words, at distances that have
	// nothing to do with the rows.
	if m.top > 0 {
		for x := 0; x < m.width; x++ {
			for y := 0; y < m.top-7 && y < 9; y++ {
				set(x, y, 0xf1f3f4)
			}
			for y := m.top - 4; y < m.top; y++ {
				set(x, y, 0xbdc1c6)
			}
		}
		for x := 10; x < m.width*2/3; x++ {
			for y := 12; y < m.top-8; y++ {
				if hash(x/2, 999, y/3)&3 == 0 {
					set(x, y, ink)
				}
			}
		}
	}
	rowTop := func(row int) int { return m.top + int(math.Round(float64(row)*m.pitch)) }
	for row := 0; rowTop(row) < m.height; row++ {
		from, to := rowTop(row), rowTop(row+1)
		fill := paper
		switch {
		case m.striped && row%2 == 1:
			fill = 0xfafafa
		case row == m.selected:
			fill = 0x0b57d0
		case m.filled != nil && m.filled(row):
			fill = 0x0000ff
		}
		hidden := m.bare || m.striped || (m.filled != nil && m.filled(row) && m.filled(row+1))
		for y := from; y < to; y++ {
			for x := 0; x < m.width; x++ {
				set(x, y, fill)
			}
		}
		if !hidden {
			// The line is the last pixel row of the row above the next.
			for x := 0; x < m.width; x++ {
				set(x, to-1, line)
			}
		}
		// Words: a band of strokes, as long as this row's words happen to be.
		long := 20 + int(hash(row, 1, 1)%uint32(max(m.width-30, 1)))
		for x := 6; x < 6+long && x < m.width-2; x++ {
			for y := from + 5; y < from+14 && y < to-2; y++ {
				if hash(x/2, row, y/3)&3 == 0 {
					colour := ink
					if fill != paper && fill != 0xfafafa {
						colour = 0xffffff
					}
					set(x, y, colour)
				}
			}
		}
	}
	return out
}

func plainSheet(pitch float64, rows int) madeSheet {
	return madeSheet{width: 180, height: int(pitch * float64(rows)), pitch: pitch, selected: -1, seed: 11}
}

// The fault this measuring exists for: two clicks by hand on two rows are
// not one row apart, and going on by their distance lands in the wrong row.
func TestTheRealDistanceBetweenRowsIsFoundFromTheScreenNotFromTheHand(t *testing.T) {
	for _, pitch := range []float64{20, 21, 24, 26.25, 31.5, 17.5} {
		sheet := plainSheet(pitch, 22)
		pixels := sheet.pixels()
		// The hand was up to seven pixels out, either way.
		for _, wobble := range []float64{-7, -3, 0, 4, 7} {
			got, why, ok := watchRowStep(pixels, sheet.width, sheet.height, pitch+wobble, int(2*pitch))
			if !ok {
				t.Fatalf("rows %.2f apart, clicks %.2f apart: no rows were seen: %s", pitch, pitch+wobble, why)
			}
			if math.Abs(got-pitch) > 0.06 {
				t.Fatalf("rows %.2f apart, clicks %.2f apart: measured %.3f", pitch, pitch+wobble, got)
			}
			// Fifty rows on, the click is still in its row: less than a quarter of a row out.
			if drift := math.Abs(got-pitch) * 50; drift > pitch/4 {
				t.Fatalf("rows %.2f apart: fifty rows on it is %.1f pixels out", pitch, drift)
			}
			// What going on by the hand's own distance would have done.
			if wobble == 7 && (pitch+wobble)*20-pitch*20 < pitch {
				t.Fatalf("the test is too easy: the hand's own distance would have stayed in the row")
			}
		}
	}
}

// The owner's first test, 16 November 2026: two Google Sheets, and no rows
// were seen. What is in the rows of a real sheet changes how bright they are
// far more than the thin lines between them do: fills, a selected row, names
// of different lengths, a heading above. Read as where the strip changes,
// not as how bright it is, none of that matters.
func TestARealSheetIsMeasuredWhateverIsInItsRows(t *testing.T) {
	const pitch = 21
	sheets := map[string]madeSheet{
		"a heading over the rows":        {top: 52},
		"a row that is selected":         {selected: 4},
		"fills that hide half the lines": {filled: func(row int) bool { return row%6 < 3 }, top: 30},
		"all of it at once":              {top: 47, selected: 3, filled: func(row int) bool { return row >= 5 && row < 9 || row >= 14 && row < 16 }},
		"a dark window":                  {dark: true, top: 40},
		"a striped list with no lines":   {striped: true},
	}
	for name, sheet := range sheets {
		sheet.width, sheet.height, sheet.pitch = 180, 22*pitch, pitch
		if name != "a row that is selected" && name != "all of it at once" {
			sheet.selected = -1
		}
		for seed := uint32(1); seed <= 12; seed++ {
			sheet.seed = seed
			pixels := sheet.pixels()
			for _, clicks := range []float64{17, 21, 26} {
				got, why, ok := watchRowStep(pixels, sheet.width, sheet.height, clicks, sheet.top+2*pitch+9)
				if !ok {
					t.Fatalf("%s (%d): clicks %.0f apart: no rows were seen: %s", name, seed, clicks, why)
				}
				if math.Abs(got-pitch) > 0.05 {
					t.Fatalf("%s (%d): clicks %.0f apart: measured %.3f for rows %d apart", name, seed, clicks, got, pitch)
				}
			}
		}
	}
	// A narrow strip, beside the window's edge, is enough.
	narrow := madeSheet{width: 46, height: 22 * pitch, pitch: pitch, selected: 5, seed: 3}
	if got, why, ok := watchRowStep(narrow.pixels(), narrow.width, narrow.height, 23, 50); !ok || math.Abs(got-pitch) > 0.05 {
		t.Fatalf("a narrow strip: got %.3f, %v: %s", got, ok, why)
	}
}

func TestSkippingRowsIsAWholeNumberOfThem(t *testing.T) {
	sheet := plainSheet(21, 30)
	pixels := sheet.pixels()
	// Every other row, and every third.
	for rows, clicks := range map[float64]float64{2: 45, 3: 60} {
		got, why, ok := watchRowStep(pixels, sheet.width, sheet.height, clicks, 100)
		if !ok || math.Abs(got-rows*21) > 0.2 {
			t.Fatalf("clicks %.0f apart on rows 21 apart: got %.2f, %v (%s); want %.0f rows", clicks, got, ok, why, rows)
		}
	}
	// Going up is the same distance.
	if got, _, ok := watchRowStep(pixels, sheet.width, sheet.height, -19, 500); !ok || math.Abs(got-21) > 0.1 {
		t.Fatalf("going up: got %.2f, %v", got, ok)
	}
}

func TestWhereNoRowsCanBeSeenItSaysSo(t *testing.T) {
	const width, height = 180, 500
	blank := make([]uint32, width*height)
	for i := range blank {
		blank[i] = 0xffffff
	}
	if _, _, ok := watchRowStep(blank, width, height, 22, 60); ok {
		t.Fatal("a blank strip has rows")
	}
	// A picture: bright and dark with no evenness to it.
	noise := make([]uint32, width*height)
	seed := uint32(7)
	for i := range noise {
		seed = seed*1664525 + 1013904223
		noise[i] = seed >> 8
	}
	if got, _, ok := watchRowStep(noise, width, height, 22, 60); ok {
		t.Fatalf("a strip with no rows in it was measured as rows %.2f apart", got)
	}
	// Rows of every height: nothing to go on by.
	uneven := make([]uint32, width*height)
	copy(uneven, blank)
	for y, row := 0, 0; y < height; row++ {
		seed = seed*1664525 + 1013904223
		y += 14 + int(seed>>28)*2
		for x := 0; x < width && y < height; x++ {
			uneven[y*width+x] = 0xe2e2e2
		}
	}
	if got, _, ok := watchRowStep(uneven, width, height, 22, 60); ok {
		t.Fatalf("rows of every height were measured as rows %.2f apart", got)
	}
	// The bars at the top of a window: a few lines that happen to stand
	// evenly, with nothing between most of them.
	bars := make([]uint32, width*height)
	copy(bars, blank)
	for _, y := range []int{22, 44, 110, 132, 198, 286, 330} {
		for x := 0; x < width; x++ {
			bars[y*width+x] = 0xc0c0c0
		}
	}
	if got, _, ok := watchRowStep(bars, width, height, 22, 60); ok {
		t.Fatalf("a few bars with gaps between them were measured as rows %.2f apart", got)
	}
	// Too short a strip to be sure of.
	short := plainSheet(21, 3)
	if _, _, ok := watchRowStep(short.pixels(), short.width, short.height, 21, 30); ok {
		t.Fatal("three rows were enough to measure by")
	}
	// What the person did does not fit the rows that are there: half a row on.
	tall := plainSheet(40, 20)
	if got, _, ok := watchRowStep(tall.pixels(), tall.width, tall.height, 60, 90); ok {
		t.Fatalf("a row and a half was taken for a whole number of rows: %.2f", got)
	}
	// A hand that barely moved is not a step.
	sheet := plainSheet(21, 20)
	if _, _, ok := watchRowStep(sheet.pixels(), sheet.width, sheet.height, 3, 50); ok {
		t.Fatal("three pixels were taken for a step")
	}
	// A strip that is not there.
	if _, _, ok := watchRowStep(nil, 0, 0, 21, 0); ok {
		t.Fatal("no strip at all was measured")
	}
}

// The rows that are measured must be the ones that were clicked: a list
// further down the window, with nothing where the click was, is another list.
func TestTheRowsMeasuredAreTheOnesThatWereClicked(t *testing.T) {
	const width, pitch = 180, 21
	list := plainSheet(pitch, 12)
	rows := list.pixels()
	// Three hundred pixels of nothing, then the list.
	const gap = 300
	pixels := make([]uint32, width*(gap+list.height))
	for i := 0; i < width*gap; i++ {
		pixels[i] = 0xffffff
	}
	copy(pixels[width*gap:], rows)
	if got, _, ok := watchRowStep(pixels, width, gap+list.height, 21, 40); ok {
		t.Fatalf("a click on nothing was measured by the list below it: %.2f", got)
	}
	if got, why, ok := watchRowStep(pixels, width, gap+list.height, 21, gap+60); !ok || math.Abs(got-pitch) > 0.05 {
		t.Fatalf("a click in the list: got %.2f, %v: %s", got, ok, why)
	}
}

// With no lines between them, lines of writing are rows only when they are
// regular enough to tell. A ragged page may not be: then it says it saw no
// rows. What it must never do is name a distance that is not theirs.
func TestLinesOfWritingAreMeasuredRightOrNotAtAll(t *testing.T) {
	measured := 0
	for seed := uint32(1); seed <= 24; seed++ {
		page := madeSheet{width: 180, height: 19 * 24, pitch: 19, bare: true, selected: -1, seed: seed}
		got, _, ok := watchRowStep(page.pixels(), page.width, page.height, 24, 50)
		if !ok {
			continue
		}
		measured++
		if math.Abs(got-19) > 0.1 {
			t.Fatalf("lines of writing 19 apart (%d): measured %.2f", seed, got)
		}
	}
	if measured < 12 {
		t.Fatalf("only %d of 24 pages of writing could be measured", measured)
	}
}

func TestAStripIsReadAsWhereItChanges(t *testing.T) {
	// Four pixel rows of four: white, white, a grey line, white again.
	white, grey := uint32(0xffffff), uint32(0xe2e2e2)
	pixels := []uint32{
		white, white, white, white,
		white, white, white, white,
		grey, grey, grey, white,
		white, white, white, white,
	}
	got := watchEdges(pixels, 4, 4)
	want := []float64{0, 0, 0.75, 0.75}
	if len(got) != 4 {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 0.001 {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	// How bright a row is does not count: a fill is its two edges and nothing between.
	fill := []uint32{white, white, 0x0000ff, 0x0000ff, 0x0000ff, 0x0000ff, white, white}
	if edges := watchEdges(fill, 2, 4); edges[1] != 1 || edges[2] != 0 || edges[3] != 1 {
		t.Fatalf("a fill: %v", edges)
	}
	// A shade too faint to be anything is not a change.
	if edges := watchEdges([]uint32{0xffffff, 0xfdfdfd}, 1, 2); edges[1] != 0 {
		t.Fatalf("two shades apart: %v", edges)
	}
	if watchEdges(pixels, 5, 4) != nil || watchEdges(nil, 0, 0) != nil {
		t.Fatal("a strip that is not there was read")
	}
}

func TestTheStripStaysInsideTheWindow(t *testing.T) {
	win := lookRect{100, 50, 800, 600}
	// Going down: a little above the click, a long way below it.
	down := watchStrip(win, lookPoint{400, 200}, 21)
	if down.Y != 200-2*21 || down.Y+down.H != 200+20*21 || down.X != 310 || down.W != 180 {
		t.Fatalf("going down: %+v", down)
	}
	// Near the edges it is cut to the window.
	corner := watchStrip(win, lookPoint{120, 620}, 21)
	if corner.X != 100 || corner.Y+corner.H != 650 || corner.W != 110 {
		t.Fatalf("near the corner: %+v", corner)
	}
	up := watchStrip(win, lookPoint{400, 500}, -21)
	if up.Y != 500-20*21 || up.Y+up.H != 500+2*21 {
		t.Fatalf("going up: %+v", up)
	}
	if got := watchStrip(win, lookPoint{2000, 2000}, 21); !got.empty() {
		t.Fatalf("a place outside the window: %+v", got)
	}
}

var pasteRows = [][]string{
	{"Customer", "Amount", "State"},
	{"Acme", "1,200.00", "paid"},
	{"Lumen <Studio>", "430.33", "late & chased"},
}

func rowsParam(rows [][]string) []any {
	out := make([]any, len(rows))
	for i, row := range rows {
		cells := make([]any, len(row))
		for j, cell := range row {
			cells[j] = cell
		}
		out[i] = cells
	}
	return out
}

// The owner, 16 November 2026: rows copied from a sheet and pasted into a
// document "just look horrible". What Jarvis puts there is a table.
func TestRowsArePutAsARealTableWithPlainWordsBesideIt(t *testing.T) {
	act, err := parseNotchAct(map[string]any{"do": "paste", "screen": true, "x": float64(9), "y": float64(9), "rows": rowsParam(pasteRows)})
	if err != nil {
		t.Fatal(err)
	}
	if act.As != "table" {
		t.Fatalf("rows with no form given are put as %q, want a table", act.As)
	}
	plain, html, shape := pasteFlavours(act)
	wantHTML := `<table style="border-collapse:collapse">` +
		`<tr><td style="border:1px solid #9aa0a6;padding:4px 8px">Customer</td><td style="border:1px solid #9aa0a6;padding:4px 8px;text-align:right">Amount</td><td style="border:1px solid #9aa0a6;padding:4px 8px">State</td></tr>` +
		`<tr><td style="border:1px solid #9aa0a6;padding:4px 8px">Acme</td><td style="border:1px solid #9aa0a6;padding:4px 8px;text-align:right">1,200.00</td><td style="border:1px solid #9aa0a6;padding:4px 8px">paid</td></tr>` +
		`<tr><td style="border:1px solid #9aa0a6;padding:4px 8px">Lumen &lt;Studio&gt;</td><td style="border:1px solid #9aa0a6;padding:4px 8px;text-align:right">430.33</td><td style="border:1px solid #9aa0a6;padding:4px 8px">late &amp; chased</td></tr>` +
		`</table>`
	if html != wantHTML {
		t.Fatalf("the table:\n%s\nwant:\n%s", html, wantHTML)
	}
	// For a program that takes no table: columns that line up, numbers to the right.
	wantPlain := "Customer          Amount  State\r\n" +
		"Acme            1,200.00  paid\r\n" +
		"Lumen <Studio>    430.33  late & chased"
	if plain != wantPlain {
		t.Fatalf("the plain words:\n%q\nwant:\n%q", plain, wantPlain)
	}
	// What its shape is taken from is the rows as a sheet would give them back.
	if shape != "Customer\tAmount\tState\r\nAcme\t1,200.00\tpaid\r\nLumen <Studio>\t430.33\tlate & chased" {
		t.Fatalf("the shape is taken from %q", shape)
	}
	if got := clipShapeOf(shape); got.Rows != 3 || got.Cols != 3 {
		t.Fatalf("its shape: %+v", got)
	}
}

func TestEachFormAPasteCanTake(t *testing.T) {
	with := func(as string) notchAct {
		act, err := parseNotchAct(map[string]any{"do": "paste", "front": true, "rows": rowsParam(pasteRows[1:]), "as": as})
		if err != nil {
			t.Fatalf("as %q: %v", as, err)
		}
		return act
	}
	// Into a sheet: tabs between cells both ways, so that it lands as cells.
	plain, html, _ := pasteFlavours(with("cells"))
	if plain != "Acme\t1,200.00\tpaid\r\nLumen <Studio>\t430.33\tlate & chased" || !strings.HasPrefix(html, "<table") {
		t.Fatalf("as cells: %q and %q", plain, html)
	}
	// A list: one line a row.
	plain, html, _ = pasteFlavours(with("list"))
	if plain != "- Acme · 1,200.00 · paid\r\n- Lumen <Studio> · 430.33 · late & chased" {
		t.Fatalf("as a list, plain: %q", plain)
	}
	if html != "<ul><li>Acme · 1,200.00 · paid</li><li>Lumen &lt;Studio&gt; · 430.33 · late &amp; chased</li></ul>" {
		t.Fatalf("as a list: %q", html)
	}
	// Plain text: words only, and nothing a program could take for a table.
	plain, html, _ = pasteFlavours(with("text"))
	if html != "" || !strings.Contains(plain, "Acme\t1,200.00") {
		t.Fatalf("as text: %q and %q", plain, html)
	}
	// Words alone are put as they are.
	one, _ := parseNotchAct(map[string]any{"do": "paste", "front": true, "text": "1,291"})
	if plain, html, shape := pasteFlavours(one); plain != "1,291" || html != "" || shape != "1,291" {
		t.Fatalf("words alone: %q %q %q", plain, html, shape)
	}
}

// What was read off a screen is words in the table, never markup, and a cell
// cannot break the table it is in.
func TestACellIsWordsWhateverItSays(t *testing.T) {
	rows := [][]string{{`<script>alert(1)</script>`, "a\tb\r\nc", `"quoted" & more`}}
	act, err := parseNotchAct(map[string]any{"do": "paste", "front": true, "rows": rowsParam(rows)})
	if err != nil {
		t.Fatal(err)
	}
	_, html, shape := pasteFlavours(act)
	if strings.Contains(html, "<script") || !strings.Contains(html, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Fatalf("markup from a cell is in the table: %s", html)
	}
	if !strings.Contains(html, "&quot;quoted&quot; &amp; more") {
		t.Fatalf("a quote or an ampersand was not escaped: %s", html)
	}
	// A tab or a line end inside a cell would make two cells, or two rows, of one.
	if got := clipShapeOf(shape); got.Rows != 1 || got.Cols != 3 {
		t.Fatalf("one row of three cells became %+v (%q)", got, shape)
	}
}

func TestTheClipboardsHTMLSaysWhereItsPartsAre(t *testing.T) {
	fragment := "<table><tr><td>caffè €</td></tr></table>"
	data := clipHTML(fragment)
	text := string(data)
	var start, end, fragmentStart, fragmentEnd int
	if _, err := fmt.Sscanf(text, "Version:0.9\r\nStartHTML:%d\r\nEndHTML:%d\r\nStartFragment:%d\r\nEndFragment:%d\r\n", &start, &end, &fragmentStart, &fragmentEnd); err != nil {
		t.Fatalf("the head could not be read: %v\n%s", err, text)
	}
	// Counted in bytes, not in letters: the fragment has letters of two and three bytes.
	if got := string(data[fragmentStart:fragmentEnd]); got != fragment {
		t.Fatalf("the fragment is said to be %q", got)
	}
	if got := string(data[start:end]); got != "<html><body><!--StartFragment-->"+fragment+"<!--EndFragment--></body></html>" {
		t.Fatalf("the HTML is said to be %q", got)
	}
	if end != len(data) {
		t.Fatalf("the HTML ends at %d of %d", end, len(data))
	}
}

func TestAPasteNeedsSomethingToPutAndSomewhereToPutIt(t *testing.T) {
	good := []map[string]any{
		{"do": "paste", "front": true, "text": "1,291"},
		{"do": "paste", "front": true, "rows": rowsParam(pasteRows), "as": "list"},
		{"do": "paste", "screen": true, "x": float64(1), "y": float64(1), "rows": rowsParam(pasteRows), "as": "cells"},
	}
	for _, params := range good {
		if _, err := parseNotchAct(params); err != nil {
			t.Errorf("%v was refused: %v", params, err)
		}
	}
	long := make([]any, notchActRowsMax+1)
	for i := range long {
		long[i] = []any{"x"}
	}
	bad := []map[string]any{
		{"do": "paste", "front": true},   // nothing to put
		{"do": "paste", "text": "1,291"}, // nowhere to put it
		{"do": "paste", "front": true, "rows": rowsParam(pasteRows), "as": "spreadsheet"}, // not a form
		{"do": "paste", "front": true, "rows": []any{[]any{}}},                            // a row of nothing
		{"do": "paste", "front": true, "rows": []any{[]any{float64(3)}}},                  // a cell that is not words
		{"do": "paste", "front": true, "rows": []any{"Acme"}},                             // a row that is not cells
		{"do": "paste", "front": true, "rows": long},
	}
	for _, params := range bad {
		if _, err := parseNotchAct(params); err == nil {
			t.Errorf("%v was taken", params)
		}
	}
}

func TestOnlyAColumnOfNumbersIsSetToTheRight(t *testing.T) {
	right := pasteRight([][]string{{"Name", "Seats", "Note", "Share"}, {"Anna", "5", "3 left", "12 %"}, {"Leo", "12", "", "(4.5)"}})
	if len(right) != 4 || right[0] || !right[1] || right[2] || !right[3] {
		t.Fatalf("got %v", right)
	}
	// One row of numbers is numbers, not a heading.
	if only := pasteRight([][]string{{"1,291", "x"}}); !only[0] || only[1] {
		t.Fatalf("one row: %v", only)
	}
}

// ---------------------------------------------------------------------------
// The Mac
// ---------------------------------------------------------------------------

func TestOnAMacTheLetterOfAKeyIsOnlyLookedAtForAShortcut(t *testing.T) {
	cases := []struct {
		code   int
		letter byte
		mods   watchMods
		want   string
	}{
		{36, 0, watchMods{}, "enter"},
		{48, 0, watchMods{Shift: true}, "shift,tab"},
		{125, 0, watchMods{}, "down"},
		{124, 0, watchMods{Shift: true}, "shift,right"},
		{117, 0, watchMods{}, "delete"},
		{8, 'c', watchMods{Cmd: true}, "cmd,c"},
		{9, 'v', watchMods{Cmd: true, Shift: true}, "cmd,shift,v"},
		{48, 0, watchMods{Cmd: true}, "cmd,tab"},
		{0, 'a', watchMods{Ctrl: true}, "ctrl,a"},
		{96, 0, watchMods{}, "f5"},
		{51, 0, watchMods{Cmd: true}, "cmd,backspace"},
	}
	for _, c := range cases {
		kind, spec := watchKeyMac(c.code, c.letter, c.mods)
		if kind != watchKeyStep || spec != c.want {
			t.Errorf("key %d with %+v: got %v %q, want a step named %q", c.code, c.mods, kind, spec, c.want)
		}
		// What is named can be pressed again, here and through the door of notch.act.
		if !notchKeysSpec(spec, false) {
			t.Errorf("%q is named by the Mac's watch but refused by notch.act", spec)
		}
		if _, err := parseMacKeys(spec); err != nil {
			t.Errorf("%q cannot be pressed again on a Mac: %v", spec, err)
		}
	}
	// A key that types is typing, whatever is held that is not Cmd or Ctrl. Option with a letter is an accent.
	for _, mods := range []watchMods{{}, {Shift: true}, {Alt: true}, {Alt: true, Shift: true}} {
		for _, code := range []int{0, 8, 9, 18, 29, 49, 51, 27, 41} {
			if kind, spec := watchKeyMac(code, 'x', mods); kind != watchKeyTyped || spec != "" {
				t.Errorf("key %d with %+v was named %q", code, mods, spec)
			}
		}
	}
	// A shortcut on a key that is neither a letter nor a digit is not named.
	if kind, spec := watchKeyMac(41, ';', watchMods{Cmd: true}); kind != watchKeyTyped || spec != "" {
		t.Errorf("Cmd with a sign key: %v %q", kind, spec)
	}
	if kind, _ := watchKeyMac(53, 0, watchMods{}); kind != watchKeyNone {
		t.Error("Esc was told")
	}
}

func TestAMacKeySpecIsTakenApartForPressing(t *testing.T) {
	keys, err := parseMacKeys("cmd,shift,v")
	if err != nil || !keys.Cmd || !keys.Shift || keys.Ctrl || keys.Alt || keys.Name != "v" {
		t.Fatalf("got %+v, %v", keys, err)
	}
	// A job shown on Windows that names the Windows key presses Cmd on a Mac.
	if keys, err := parseMacKeys("win,d"); err != nil || !keys.Cmd || keys.Name != "d" {
		t.Fatalf("got %+v, %v", keys, err)
	}
	if keys, err := parseMacKeys("shift,down"); err != nil || !keys.Shift || keys.Name != "down" {
		t.Fatalf("got %+v, %v", keys, err)
	}
	for _, bad := range []string{"", "cmd", "cmd,c,v", "cmd,,c", "escape", "cmd,;", "hello"} {
		if _, err := parseMacKeys(bad); err == nil {
			t.Errorf("%q was taken", bad)
		}
	}
	// Every named key has a code to press, and every letter and digit a place on the keyboard to fall back on.
	for _, name := range watchMacNamedKeys {
		if _, ok := watchMacKeyCodes[name]; !ok {
			t.Errorf("%q is named and cannot be pressed", name)
		}
	}
	for c := byte('a'); c <= 'z'; c++ {
		if _, ok := watchMacAnsiKeys[c]; !ok {
			t.Errorf("no key for %q", c)
		}
	}
	for c := byte('0'); c <= '9'; c++ {
		if _, ok := watchMacAnsiKeys[c]; !ok {
			t.Errorf("no key for %q", c)
		}
	}
}

func TestAMacControlIsCalledWhatTheLookAlreadyCallsIt(t *testing.T) {
	cases := []struct{ role, subrole, kind, local string }{
		{"AXButton", "", "Button", ""},
		{"AXRadioButton", "AXTabButton", "TabItem", ""},
		{"AXRow", "", "ListItem", "row"},
		{"AXOutlineRow", "", "TreeItem", "row"},
		{"AXCell", "", "DataItem", "cell"},
		{"AXTextField", "", "Edit", ""},
		{"AXTextArea", "", "Document", ""},
		{"AXWebArea", "", "Document", ""},
		{"AXLink", "", "Hyperlink", "link"},
		{"AXHeading", "", "Text", "heading"},
		{"AXSomethingNew", "", "Custom", ""},
	}
	for _, c := range cases {
		if kind, local := macRole(c.role, c.subrole); kind != c.kind || local != c.local {
			t.Errorf("%s (%s): got %q %q, want %q %q", c.role, c.subrole, kind, local, c.kind, c.local)
		}
	}
	// What the look makes of them: the same words a person is told on Windows.
	row, local := macRole("AXRow", "")
	if got := lookKindOf(row, local, lookRect{0, 0, 600, 22}); got != "row" {
		t.Errorf("a row of a Mac table is a %q", got)
	}
	cell, local := macRole("AXCell", "")
	if got := lookKindOf(cell, local, lookRect{0, 0, 90, 22}); got != "cell" {
		t.Errorf("a cell of a Mac table is a %q", got)
	}
	// A field, a cell and a page of writing take a thing that is put; a button does not.
	for _, role := range []string{"AXTextField", "AXTextArea", "AXWebArea", "AXCell", "AXComboBox"} {
		kind, local := macRole(role, "")
		if !lookTakes(lookThing{Kind: lookKindOf(kind, local, lookRect{0, 0, 90, 22}), Role: kind}) {
			t.Errorf("%s does not take a thing", role)
		}
	}
	if kind, local := macRole("AXButton", ""); lookTakes(lookThing{Kind: lookKindOf(kind, local, lookRect{0, 0, 90, 22}), Role: kind}) {
		t.Error("a button takes a thing")
	}
	// A climb stops at a window, a list and a table, and a button is a thing by itself.
	for _, role := range []string{"AXWindow", "AXList", "AXTable", "AXOutline", "AXWebArea", "AXToolbar"} {
		if kind, _ := macRole(role, ""); !lookEdgeRoles[kind] {
			t.Errorf("a climb goes past %s (%s)", role, kind)
		}
	}
	for _, role := range []string{"AXButton", "AXLink", "AXCheckBox", "AXTextField", "AXMenuItem", "AXRow", "AXCell"} {
		if kind, _ := macRole(role, ""); !lookItemRoles[kind] || !macActsOn(kind) {
			t.Errorf("%s (%s) is not a thing by itself", role, kind)
		}
	}
}

func TestTypingAndFindingAWindowAreAskedForInFull(t *testing.T) {
	good := []map[string]any{
		actParams("type", map[string]any{"text": "notes for Thursday"}),
		actParams("find", map[string]any{"app": "TextEdit"}),
		// With no name it can still be the very window, if that is still there.
		actParams("find", nil),
	}
	for _, params := range good {
		if _, err := parseNotchAct(params); err != nil {
			t.Errorf("%v was refused: %v", params, err)
		}
	}
	bad := []map[string]any{
		{"do": "type", "text": "typed into no window"},
		actParams("type", nil),
		actParams("type", map[string]any{"text": strings.Repeat("x", notchActTypeMax+1)}),
		{"do": "find", "app": "TextEdit"},
		{"do": "find", "app": "TextEdit", "win": map[string]any{"id": "0x1a", "pid": float64(7)}}, // no size to know it by
	}
	for _, params := range bad {
		if _, err := parseNotchAct(params); err == nil {
			t.Errorf("%v was taken", params)
		}
	}
	// The name of a program is words from outside: one line, and not long.
	act, err := parseNotchAct(actParams("find", map[string]any{"app": "Text\nEdit " + strings.Repeat("x", 200)}))
	if err != nil || strings.ContainsAny(act.App, "\n\r") || len([]rune(act.App)) > 80 {
		t.Fatalf("got %q, %v", act.App, err)
	}
}

func TestWhatIsHeldWithAClickIsNamedOnBothSystems(t *testing.T) {
	if got := watchClickMods(watchMods{Shift: true}); got != "shift" {
		t.Errorf("Shift: %q", got)
	}
	if got := watchClickMods(watchMods{Cmd: true}); got != "cmd" {
		t.Errorf("Cmd: %q", got)
	}
	if got := watchClickMods(watchMods{Ctrl: true, Shift: true, Cmd: true}); got != "ctrl,shift,cmd" {
		t.Errorf("three keys: %q", got)
	}
	// The right Alt that types a third sign is not a key held with a click.
	if got := watchClickMods(watchMods{Ctrl: true, Alt: true, AltGr: true}); got != "" {
		t.Errorf("AltGr: %q", got)
	}
	for _, mods := range []string{"shift", "cmd", "ctrl,shift,cmd"} {
		if !notchKeysSpec(mods, true) {
			t.Errorf("%q is named and refused", mods)
		}
	}
}
