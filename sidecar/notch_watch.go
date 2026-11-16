package main

// Watching what the hands do, and doing it again (pass 10).
//
// Two things on the notch need to know what the person did, not what they
// said:
//
//   - "Watch me": a job shown once. That is the skill recorder (recorder.go),
//     which this file gives three things it did not have: the keys that are
//     steps (Enter, the arrows, Ctrl + C), where in its window a click landed,
//     and which window that was.
//   - Catching a repeated job by itself: with the notch on, the same hooks
//     stay in, and tell the brain the SHAPE of what is done and nothing else.
//
// The shape of an action is: a click, in which window, at which place in it;
// or a named key or shortcut, in which window. It is never a letter that was
// typed, never the text of a field, never the name of a control or the title
// of a window. A stretch of typing is told as one word, "typed", so that the
// brain knows there is a part of the job it did not see and offers nothing.
//
// Where the notch looks away (a password is being typed, a bank, an app on
// the person's list, watching switched off: notch_where.go) nothing is told,
// not even the shape. The brain hears "gap" once, so that what came before
// and what comes after are not taken for one job.
//
// Doing it again is notch.act: a click at a place in a window, a shortcut, a
// copy that says only how much was copied, a paste. Jarvis's own pointer goes
// to the place first (notch_look.go), so it is seen where each thing lands.
//
// No platform calls in this file.

import (
	"fmt"
	"hash/fnv"
	"math"
	"strings"
	"unicode/utf8"
)

// watchMods is which of the keys that change other keys are down.
type watchMods struct {
	Ctrl, Alt, Shift, Win bool
	// The right Alt on keyboards where it types the third sign on a key
	// (Italian, German, French): Windows reports it as Ctrl + Alt, and what is
	// pressed with it is typing, not a shortcut.
	AltGr bool
}

type watchKeyKind uint8

const (
	// Nothing to tell: a key that only changes other keys, Esc (the notch's
	// own), a lock key.
	watchKeyNone watchKeyKind = iota
	// Typing, or a key that cannot be named: told as "typed", never as a key.
	watchKeyTyped
	// A step: a named key or a shortcut, in the words press_keys takes.
	watchKeyStep
)

// The keys that have a name. These are the names press_keys takes
// (win32_native_windows.go: winNamedKeys), so what was watched can be pressed
// again as it is.
var watchNamedKeys = map[uint32]string{
	0x0D: "enter", 0x09: "tab", 0x2E: "delete", 0x2D: "insert",
	0x21: "pageup", 0x22: "pagedown", 0x23: "end", 0x24: "home",
	0x25: "left", 0x26: "up", 0x27: "right", 0x28: "down",
}

func watchIsModifier(vk uint32) bool {
	switch vk {
	case 0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C, 0x14, 0x90, 0x91:
		return true
	}
	return false
}

// watchKey says what a key going down is: a step with its name, typing, or
// nothing. vk is the Windows virtual key.
//
// What is a step: a named key (Enter, Tab, Delete, the arrows, Home, End,
// Page Up and Down, F1 to F12), alone or with Shift, Ctrl, Alt or Win; and a
// letter or a digit with Ctrl, Alt or Win. Everything else that puts a sign
// in a field is typing, and is never named. Backspace and Space alone are
// typing too: they are part of writing.
func watchKey(vk uint32, m watchMods) (watchKeyKind, string) {
	if watchIsModifier(vk) || vk == 0x1B {
		return watchKeyNone, ""
	}
	chord := (m.Ctrl || m.Alt || m.Win) && !m.AltGr
	with := func(name string, shift bool) string {
		parts := make([]string, 0, 5)
		if m.Ctrl && !m.AltGr {
			parts = append(parts, "ctrl")
		}
		if m.Alt && !m.AltGr {
			parts = append(parts, "alt")
		}
		if m.Win {
			parts = append(parts, "win")
		}
		if shift && m.Shift {
			parts = append(parts, "shift")
		}
		return strings.Join(append(parts, name), ",")
	}
	if name, ok := watchNamedKeys[vk]; ok {
		return watchKeyStep, with(name, true)
	}
	if vk >= 0x70 && vk <= 0x7B {
		return watchKeyStep, with(fmt.Sprintf("f%d", vk-0x70+1), true)
	}
	if chord {
		switch {
		case vk >= 0x41 && vk <= 0x5A:
			return watchKeyStep, with(string(rune('a'+(vk-0x41))), true)
		case vk >= 0x30 && vk <= 0x39:
			return watchKeyStep, with(string(rune('0'+(vk-0x30))), true)
		case vk == 0x08:
			return watchKeyStep, with("backspace", true)
		case vk == 0x20:
			return watchKeyStep, with("space", true)
		}
		// A shortcut on a key whose sign depends on the keyboard: it cannot be
		// named in a way that presses the same key again.
		return watchKeyTyped, ""
	}
	return watchKeyTyped, ""
}

// watchFlow keeps the two words that are told once and not again: that the
// person is typing, and that this program is looking away.
type watchFlow struct {
	typing bool
	away   bool
}

// Typed is a key that types. True the first time since the last step: then
// "typed" is told.
func (f *watchFlow) Typed() bool {
	if f.typing {
		return false
	}
	f.typing = true
	return true
}

// Step is a click or a named key: typing, if there was any, is over.
func (f *watchFlow) Step() { f.typing = false }

// Away is something done where this program does not look. True the first
// time: then "gap" is told. Nothing else is told until it looks again.
func (f *watchFlow) Away() bool {
	f.typing = false
	if f.away {
		return false
	}
	f.away = true
	return true
}

// Looking is something done where this program looks.
func (f *watchFlow) Looking() { f.away = false }

// watchWindow is a window as a step names it: a number that stays the same
// while the window lives, the process it belongs to, and its size. The size
// is how doing it again knows the window is as it was.
type watchWindow struct {
	ID   string
	Pid  uint32
	App  string
	W, H int
}

func (w watchWindow) payload() map[string]any {
	return map[string]any{"id": w.ID, "pid": w.Pid, "w": w.W, "h": w.H}
}

// watchClickPayload is a click as the brain is told of it while the notch
// watches by itself: the window, the place in it, and what was held down.
func watchClickPayload(win watchWindow, x, y int, mods string, at int64) map[string]any {
	payload := map[string]any{"kind": "click", "app": win.App, "win": win.payload(), "pt": map[string]any{"x": x, "y": y}, "ts": at}
	if mods != "" {
		payload["mods"] = mods
	}
	return payload
}

func watchKeysPayload(win watchWindow, keys string, at int64) map[string]any {
	return map[string]any{"kind": "keys", "keys": keys, "app": win.App, "win": win.payload(), "ts": at}
}

// watchClickMods is what was held down with a click, in press_keys' words.
func watchClickMods(m watchMods) string {
	parts := make([]string, 0, 3)
	if m.Ctrl && !m.AltGr {
		parts = append(parts, "ctrl")
	}
	if m.Shift {
		parts = append(parts, "shift")
	}
	if m.Alt && !m.AltGr {
		parts = append(parts, "alt")
	}
	return strings.Join(parts, ",")
}

// ---------------------------------------------------------------------------
// What was copied, as a shape
// ---------------------------------------------------------------------------

// clipShape is what a copy put on the clipboard, without what it says: how
// many lines, how many cells across (tabs part them, as a spreadsheet copies
// a row), how many signs, and a number that is the same for the same text.
// The brain is told this and never the text.
type clipShape struct {
	Empty bool
	Rows  int
	Cols  int
	Chars int
	Hash  string
}

// clipShapeOf reads the shape of a text. Line ends at its end do not count: a
// row copied from a sheet ends in one and the same row read back from a cell
// does not.
func clipShapeOf(text string) clipShape {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.TrimRight(text, "\n")
	if strings.TrimSpace(text) == "" {
		return clipShape{Empty: true}
	}
	lines := strings.Split(text, "\n")
	cols := 1
	for _, line := range lines {
		if n := strings.Count(line, "\t") + 1; n > cols {
			cols = n
		}
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(text))
	return clipShape{Rows: len(lines), Cols: cols, Chars: utf8.RuneCountInString(text), Hash: fmt.Sprintf("%016x", h.Sum64())}
}

func (s clipShape) payload() map[string]any {
	return map[string]any{"empty": s.Empty, "rows": s.Rows, "cols": s.Cols, "chars": s.Chars, "hash": s.Hash}
}

// ---------------------------------------------------------------------------
// notch.act: one thing done again
// ---------------------------------------------------------------------------

// notchAct is one request to do something where it can be seen.
type notchAct struct {
	// click, keys, copy, paste, hand, home, front, count, pitch
	Do string
	// The window it is done in, as a step named it. Empty for a place given
	// in the screen's own pixels (Screen).
	Win watchWindow
	// The place: in the window, from its top left corner; or on the screen.
	X, Y   int
	Screen bool
	// What is held down with a click, or the keys to press.
	Mods string
	Keys string
	// Twice, quickly.
	Double bool
	// Which of Jarvis's pointers goes there: 0, 1 or 2.
	Hand int
	// hand: come up beside the person's own pointer instead of out of the notch.
	Beside bool
	// paste: what is put there. Either words as they are, or rows of cells
	// with the form they are to take: "cells" (into a sheet), "table",
	// "list" or "text".
	Text string
	Rows [][]string
	As   string
	// paste: where the person already is, with no click first: at the caret
	// of the window in front.
	Front bool
	// copy: so many cells to the right and down are taken into the selection
	// first, to read back a thing that was put there earlier.
	Right, Down int
	// count: how far the place moves on each time, and the most that are counted.
	Dx, Dy, Most int
}

// The most a paste may hold: a few hundred rows.
const notchActTextMax = 64 * 1024

// The most rows and cells a paste may hold.
const (
	notchActRowsMax  = 500
	notchActCellsMax = 60
)

// The furthest a selection may be stretched before a copy.
const notchActStretchMax = 200

func parseNotchAct(params map[string]any) (notchAct, error) {
	var act notchAct
	act.Do, _ = params["do"].(string)
	switch act.Do {
	case "click", "keys", "copy", "paste", "hand", "home", "front", "count", "pitch":
	default:
		return act, fmt.Errorf("notch.act: do must be click, keys, copy, paste, hand, home, front, count or pitch")
	}
	whole := func(key string, most float64) (int, bool, error) {
		raw, present := params[key]
		if !present {
			return 0, false, nil
		}
		n, ok := raw.(float64)
		if !ok || math.IsNaN(n) || math.Abs(n) > most {
			return 0, false, fmt.Errorf("notch.act: %s is not a number it can be", key)
		}
		return int(math.Round(n)), true, nil
	}
	if win, ok := params["win"].(map[string]any); ok {
		act.Win.ID, _ = win["id"].(string)
		if pid, ok := win["pid"].(float64); ok && pid > 0 && pid < math.MaxUint32 {
			act.Win.Pid = uint32(pid)
		}
		if w, ok := win["w"].(float64); ok && w > 0 && w < 100000 {
			act.Win.W = int(w)
		}
		if h, ok := win["h"].(float64); ok && h > 0 && h < 100000 {
			act.Win.H = int(h)
		}
		if !notchWindowID(act.Win.ID) || act.Win.Pid == 0 {
			return act, fmt.Errorf("notch.act: the window is not named as a step names one")
		}
	}
	var err error
	var hasX, hasY bool
	if act.X, hasX, err = whole("x", 200000); err != nil {
		return act, err
	}
	if act.Y, hasY, err = whole("y", 200000); err != nil {
		return act, err
	}
	act.Screen, _ = params["screen"].(bool)
	if act.Hand, _, err = whole("hand", 2); err != nil || act.Hand < 0 {
		return act, fmt.Errorf("notch.act: hand is 0, 1 or 2")
	}
	if act.Right, _, err = whole("right", notchActStretchMax); err != nil || act.Right < 0 {
		return act, fmt.Errorf("notch.act: right is a count of cells")
	}
	if act.Down, _, err = whole("down", notchActStretchMax); err != nil || act.Down < 0 {
		return act, fmt.Errorf("notch.act: down is a count of cells")
	}
	if act.Dx, _, err = whole("dx", 5000); err != nil {
		return act, err
	}
	if act.Dy, _, err = whole("dy", 5000); err != nil {
		return act, err
	}
	if act.Most, _, err = whole("most", notchActStretchMax); err != nil || act.Most < 0 {
		return act, fmt.Errorf("notch.act: most is a count")
	}
	act.Mods, _ = params["mods"].(string)
	act.Keys, _ = params["keys"].(string)
	act.Double, _ = params["double"].(bool)
	act.Beside, _ = params["beside"].(bool)
	act.Text, _ = params["text"].(string)
	act.Front, _ = params["front"].(bool)
	if raw, ok := params["rows"].([]any); ok {
		size := 0
		for _, rawRow := range raw {
			cells, ok := rawRow.([]any)
			if !ok || len(cells) == 0 || len(cells) > notchActCellsMax || len(act.Rows) >= notchActRowsMax {
				return act, fmt.Errorf("notch.act: rows are rows of cells, and not more than %d of %d", notchActRowsMax, notchActCellsMax)
			}
			row := make([]string, 0, len(cells))
			for _, rawCell := range cells {
				cell, ok := rawCell.(string)
				if !ok {
					return act, fmt.Errorf("notch.act: a cell is words")
				}
				size += len(cell) + 1
				row = append(row, pasteCell(cell))
			}
			act.Rows = append(act.Rows, row)
		}
		if size > notchActTextMax {
			return act, fmt.Errorf("notch.act: the rows hold more than %d bytes", notchActTextMax)
		}
		act.As, _ = params["as"].(string)
		switch act.As {
		case "":
			act.As = "table"
		case "cells", "table", "list", "text":
		default:
			return act, fmt.Errorf("notch.act: as is cells, table, list or text")
		}
	}
	if !notchKeysSpec(act.Mods, true) {
		return act, fmt.Errorf("notch.act: mods is ctrl, shift and alt, parted by commas")
	}
	placed := hasX && hasY && (act.Screen || act.Win.ID != "")
	switch act.Do {
	case "click":
		if !placed {
			return act, fmt.Errorf("notch.act: a click needs a place in a window")
		}
	case "paste":
		if !placed && !act.Front {
			return act, fmt.Errorf("notch.act: a paste needs a place, or to go where the person is")
		}
		if len(act.Rows) == 0 && (act.Text == "" || len(act.Text) > notchActTextMax) {
			return act, fmt.Errorf("notch.act: a paste needs words or rows, and no more than %d bytes of them", notchActTextMax)
		}
	case "keys", "copy":
		if act.Win.ID == "" {
			return act, fmt.Errorf("notch.act: keys are pressed in a window that a step named")
		}
		if act.Do == "keys" && (act.Keys == "" || !notchKeysSpec(act.Keys, false)) {
			return act, fmt.Errorf("notch.act: keys are named keys and shortcuts, parted by commas")
		}
		if act.Do == "copy" && act.Keys != "" && !notchKeysSpec(act.Keys, false) {
			return act, fmt.Errorf("notch.act: the copy's keys are named keys and shortcuts")
		}
	case "hand":
		if !placed && !act.Beside {
			return act, fmt.Errorf("notch.act: the pointer needs a place to go to")
		}
	case "count":
		if !placed || act.Screen || (act.Dx == 0 && act.Dy == 0) || act.Most < 1 {
			return act, fmt.Errorf("notch.act: counting needs a place in a window, a way on, and a most")
		}
	case "pitch":
		if !placed || act.Screen || act.Dy == 0 {
			return act, fmt.Errorf("notch.act: measuring rows needs a place in a window and how far the hand went down or up")
		}
	}
	return act, nil
}

// watchCountLeft counts how many more things stand after one, each a step
// further on, from what the window says about itself. thing(k) is what is at
// the place k steps on (0 is the last one the person did), and whether there
// is anything there at all.
//
// It counts while there is a thing of the same kind that says something. It
// stops at the first that is another kind of thing, or says nothing (an empty
// cell, the space under a list). It cannot tell, and says so, when the next
// place holds the very same thing as the one before: then the window draws
// its rows itself and describes one large thing, not a list of them.
func watchCountLeft(thing func(k int) (lookThing, bool), most int) (left int, known bool) {
	first, ok := thing(0)
	if !ok {
		return 0, false
	}
	prev := first.Rect
	for k := 1; k <= most; k++ {
		next, ok := thing(k)
		if !ok || next.Role != first.Role {
			break
		}
		if next.Rect == prev {
			return 0, false
		}
		if !watchSaysSomething(next) {
			break
		}
		prev = next.Rect
		left++
	}
	return left, true
}

// watchSaysSomething is whether a thing holds anything: a cell by what is in
// it (its name is only its place, "B7"), anything else by its name too.
func watchSaysSomething(thing lookThing) bool {
	if thing.Value != "" || len(thing.Parts) > 0 {
		return true
	}
	return thing.Kind != "cell" && thing.Name != ""
}

// notchWindowID says whether a text is a window's number as a step writes it.
func notchWindowID(id string) bool {
	if len(id) < 3 || len(id) > 18 || !strings.HasPrefix(id, "0x") {
		return false
	}
	for _, c := range id[2:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// notchKeysSpec says whether a text is keys as watchKey names them: only
// those are pressed again. With onlyMods, only the keys that change others.
// The empty text is no keys, which is allowed for mods.
func notchKeysSpec(spec string, onlyMods bool) bool {
	if spec == "" {
		return onlyMods
	}
	if len(spec) > 40 {
		return false
	}
	parts := strings.Split(spec, ",")
	mains, chord, types := 0, false, false
	for _, part := range parts {
		switch part {
		case "ctrl", "alt", "win":
			chord = true
			continue
		case "shift":
			continue
		}
		if onlyMods {
			return false
		}
		mains++
		if len(part) == 1 && ((part[0] >= 'a' && part[0] <= 'z') || (part[0] >= '0' && part[0] <= '9')) {
			types = true
			continue
		}
		if part == "backspace" || part == "space" {
			types = true
			continue
		}
		named := false
		for _, name := range watchNamedKeys {
			if name == part {
				named = true
			}
		}
		if !named {
			var n int
			if _, err := fmt.Sscanf(part, "f%d", &n); err != nil || n < 1 || n > 12 || part != fmt.Sprintf("f%d", n) {
				return false
			}
		}
	}
	if onlyMods {
		return true
	}
	// A key that types is a step only as a shortcut: alone it would be typing.
	return mains == 1 && (chord || !types)
}

// notchActPlace is where in the screen a place in a window is, given where
// the window is now. It refuses a window that is not the size it was when the
// step was shown: what was at that place then is somewhere else now.
func notchActPlace(act notchAct, now lookRect) (lookPoint, error) {
	if act.Screen {
		return lookPoint{act.X, act.Y}, nil
	}
	if now.empty() {
		return lookPoint{}, &notchActError{"gone", "the window is not there any more"}
	}
	if act.Win.W > 0 && (absInt(now.W-act.Win.W) > 2 || absInt(now.H-act.Win.H) > 2) {
		return lookPoint{}, &notchActError{"moved", "the window is not the size it was"}
	}
	if act.X < 0 || act.Y < 0 || act.X >= now.W || act.Y >= now.H {
		return lookPoint{}, &notchActError{"outside", "the place is not inside the window"}
	}
	return lookPoint{now.X + act.X, now.Y + act.Y}, nil
}

// notchActError is a refusal the brain can tell apart: a word for it, and a
// sentence for the log.
type notchActError struct {
	Why  string
	Text string
}

func (e *notchActError) Error() string { return e.Text }

// notchActRefusal is the answer when something was not done: said as a
// result, not as an error, so that the brain reads the word and not a text.
func notchActRefusal(err *notchActError) *RPCResult {
	return &RPCResult{Result: map[string]any{"done": false, "why": err.Why}}
}

// The quick hop of a pointer that is already out, from one thing to the next.
func lookHandHop(a, b lookPoint) (ms int) {
	far := math.Hypot(float64(b.X-a.X), float64(b.Y-a.Y))
	took := 150 + far/5
	if took > 420 {
		took = 420
	}
	return int(took)
}

// ---------------------------------------------------------------------------
// The two requests, and what a platform gives them
// ---------------------------------------------------------------------------

// The event the brain hears what was watched under.
const notchWatchEvent = "notch.watch"

var (
	// notchWatchSet puts the hooks in, or lets them go, for the notch watching
	// by itself. Nil where watching is not built.
	notchWatchSet func(on bool) error
	// platformNotchAct does one thing again. Nil where it is not built.
	platformNotchAct func(act notchAct) (*RPCResult, error)
)

var errNotchWatchNotHere = fmt.Errorf("watching what the hands do is not built for this system yet")

// notchWatchOff stops the watching: the notch is off, or the brain is gone.
func notchWatchOff() {
	if notchWatchSet != nil {
		_ = notchWatchSet(false)
	}
}

// makeNotchWatchHandler serves notch.watch: {on: true} and {on: false}.
func makeNotchWatchHandler() RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		on, _ := params["on"].(bool)
		if notchWatchSet == nil {
			return nil, fmt.Errorf("notch.watch: %w", errNotchWatchNotHere)
		}
		if err := notchWatchSet(on); err != nil {
			return nil, fmt.Errorf("notch.watch: %w", err)
		}
		return &RPCResult{Result: map[string]any{"watching": on}}, nil
	}
}

// makeNotchActHandler serves notch.act.
func makeNotchActHandler() RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		act, err := parseNotchAct(params)
		if err != nil {
			return nil, err
		}
		if platformNotchAct == nil {
			return nil, fmt.Errorf("notch.act: %w", errNotchWatchNotHere)
		}
		return platformNotchAct(act)
	}
}

// ---------------------------------------------------------------------------
// How far apart the rows really are
// ---------------------------------------------------------------------------

// Two clicks by hand on two rows are never exactly one row apart: a hand
// lands a few pixels higher in one row and lower in the next. Going on by
// that distance drifts, and after a few rows the click is in the wrong row.
// So before Jarvis goes on down a list, the desktop app measures how far
// apart the rows really are, from the screen itself.
//
// Rows that stand at even distances make the screen repeat itself down the
// page: the lines of a grid, or line after line of writing. watchPitch finds
// the distance at which a strip of the screen is most like itself, to a
// fraction of a pixel. That works in any program, because it asks the
// program nothing.

const (
	// A strip must be at least this like itself, one row down, for the rows
	// to count as seen. 1 is exactly alike, 0 is not alike at all.
	notchPitchLikeness = 0.5
	// The fewest rows a strip must hold for its rows to be measured.
	notchPitchRows = 5
)

// watchPitch measures how far apart rows stand. profile is how bright the
// screen is at each pixel down a strip (one number a pixel row), and about is
// roughly how far apart two of the person's clicks were. It gives the
// distance the person moved, made exact: a whole number of rows times the
// distance between two rows. False when no rows can be seen there, or when
// what the person did does not fit them.
func watchPitch(profile []float64, about float64) (float64, bool) {
	about = math.Abs(about)
	n := len(profile)
	if about < 6 || n < int(about)*notchPitchRows {
		return 0, false
	}
	// A line one pixel thin is smoothed to three: rows are seldom a whole
	// number of pixels apart (at 125% and 150% they are not), and a thin line
	// laid over itself half a pixel off would look unlike itself.
	smooth := append([]float64(nil), profile...)
	for pass := 0; pass < 2; pass++ {
		prev := smooth[0]
		for i := 1; i+1 < n; i++ {
			here := smooth[i]
			smooth[i] = (prev + 2*here + smooth[i+1]) / 4
			prev = here
		}
	}
	mean := 0.0
	for _, v := range smooth {
		mean += v
	}
	mean /= float64(n)
	power := 0.0
	for i := range smooth {
		smooth[i] -= mean
		power += smooth[i] * smooth[i]
	}
	if power < 1e-6 {
		// A blank strip: nothing repeats because nothing is there.
		return 0, false
	}
	// How like itself the strip is when laid over itself `lag` pixels down.
	// The lag need not be a whole number: between two pixels it is read as
	// the part of each that it covers.
	like := func(lag float64) float64 {
		whole := int(math.Floor(lag))
		part := lag - float64(whole)
		if whole < 1 || whole+2 >= n {
			return 0
		}
		sum, a, b := 0.0, 0.0, 0.0
		for i := 0; i+whole+1 < n; i++ {
			moved := smooth[i+whole]*(1-part) + smooth[i+whole+1]*part
			sum += smooth[i] * moved
			a += smooth[i] * smooth[i]
			b += moved * moved
		}
		if a < 1e-9 || b < 1e-9 {
			return 0
		}
		return sum / math.Sqrt(a*b)
	}
	// The best lag near a guess, looked for in steps of a twentieth of a pixel.
	near := func(guess, reach float64) (float64, float64) {
		best, bestLike := guess, -2.0
		for lag := guess - reach; lag <= guess+reach; lag += 0.05 {
			if l := like(lag); l > bestLike {
				best, bestLike = lag, l
			}
		}
		return best, bestLike
	}
	// The person may have gone one, two or three rows on, and their hand may
	// have been most of a row out. So one row is between a third of their
	// distance and that distance with a hand's error added.
	const least = 5.0
	from, to := math.Max(least, about/3-2), math.Min(about+10, float64(n)/notchPitchRows)
	pitch, pitchLike := 0.0, 0.0
	for lag := from; lag <= to; lag += 0.25 {
		if l := like(lag); l > pitchLike {
			pitch, pitchLike = lag, l
		}
	}
	if pitch == 0 || pitchLike < notchPitchLikeness {
		return 0, false
	}
	// A strip that is like itself one row down is like itself two rows down
	// too. If half or a third of the distance found fits nearly as well, that
	// is the row, and what was found was two or three of them.
	for _, parts := range []float64{3, 2} {
		if pitch/parts < least {
			continue
		}
		if shorter, shorterLike := near(pitch/parts, 0.75); shorterLike >= 0.8*pitchLike {
			pitch, pitchLike = shorter, shorterLike
			break
		}
	}
	pitch, _ = near(pitch, 0.5)
	// Made exact over many rows: where the strip is most like itself m rows
	// down, divided by m. An error of a twentieth of a pixel there is a
	// fraction of that a row.
	for m := 2.0; m*pitch < float64(n)/2; m++ {
		far, farLike := near(pitch*m, 1)
		if farLike < notchPitchLikeness {
			break
		}
		pitch = far / m
	}
	rows := math.Round(about / pitch)
	if rows < 1 || math.Abs(about-rows*pitch) > 0.45*pitch {
		// What the person did is not a whole number of these rows.
		return 0, false
	}
	return rows * pitch, true
}

// watchProfile turns a strip of the screen into how bright each pixel row
// is. pixels are the strip's own, row after row, each 0x00RRGGBB.
func watchProfile(pixels []uint32, width, height int) []float64 {
	if width <= 0 || height <= 0 || len(pixels) < width*height {
		return nil
	}
	profile := make([]float64, height)
	for y := 0; y < height; y++ {
		sum := 0.0
		for _, p := range pixels[y*width : (y+1)*width] {
			sum += 0.299*float64((p>>16)&0xff) + 0.587*float64((p>>8)&0xff) + 0.114*float64(p&0xff)
		}
		profile[y] = sum / float64(width)
	}
	return profile
}

// watchStrip is the part of a window a row's distance is measured in: a band
// round the place that was clicked, running several rows up and many rows
// down (or the other way, going up), kept inside the window.
func watchStrip(win lookRect, at lookPoint, about float64) lookRect {
	step := int(math.Ceil(math.Abs(about)))
	top, bottom := at.Y-4*step, at.Y+16*step
	if about < 0 {
		top, bottom = at.Y-16*step, at.Y+4*step
	}
	left, right := at.X-90, at.X+90
	top, bottom = max(top, win.Y), min(bottom, win.Y+win.H)
	left, right = max(left, win.X), min(right, win.X+win.W)
	if bottom <= top || right <= left {
		return lookRect{}
	}
	return lookRect{left, top, right - left, bottom - top}
}

// ---------------------------------------------------------------------------
// What is put somewhere, in the form it is to take
// ---------------------------------------------------------------------------

// Rows copied out of a sheet and pasted into a document as they are come out
// as words with gaps between them. So what Jarvis puts somewhere is put on
// the clipboard twice, the way a spreadsheet does it: once as a real table
// (or a list), for a program that takes one, and once as plain words, for a
// program that does not. A document then gets a table, a sheet gets cells,
// and a plain field gets columns that line up.

// pasteCell makes a text fit to be one cell: one line, no tabs.
func pasteCell(text string) string {
	return strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, text)), " ")
}

// pasteTSV is rows as a spreadsheet copies them: cells parted by tabs, rows
// by line ends. This is also what reading the cells back gives, so it is what
// a paste's shape is taken from.
func pasteTSV(rows [][]string) string {
	lines := make([]string, len(rows))
	for i, row := range rows {
		lines[i] = strings.Join(row, "\t")
	}
	return strings.Join(lines, "\r\n")
}

// pasteNumber says whether a cell is a number as people write one in a
// table: such a column is set to the right, in a table and in plain words.
func pasteNumber(cell string) bool {
	digits := 0
	for _, r := range cell {
		switch {
		case r >= '0' && r <= '9':
			digits++
		case strings.ContainsRune(" .,'-+()%$€£¥", r):
		default:
			return false
		}
	}
	return digits > 0
}

// pasteRight says which columns hold numbers and nothing else (a heading in
// the first row does not count against them).
func pasteRight(rows [][]string) []bool {
	width := 0
	for _, row := range rows {
		width = max(width, len(row))
	}
	right := make([]bool, width)
	for col := range right {
		numbers := 0
		right[col] = true
		for i, row := range rows {
			if col >= len(row) || row[col] == "" {
				continue
			}
			if pasteNumber(row[col]) {
				numbers++
			} else if i > 0 || len(rows) == 1 {
				right[col] = false
			}
		}
		if numbers == 0 {
			right[col] = false
		}
	}
	return right
}

// pasteAligned is rows as plain words that line up: every column as wide as
// its widest cell, two spaces between columns, numbers set to the right.
func pasteAligned(rows [][]string) string {
	right := pasteRight(rows)
	widths := make([]int, len(right))
	for _, row := range rows {
		for col, cell := range row {
			widths[col] = max(widths[col], utf8.RuneCountInString(cell))
		}
	}
	lines := make([]string, len(rows))
	for i, row := range rows {
		var line strings.Builder
		for col, cell := range row {
			pad := strings.Repeat(" ", widths[col]-utf8.RuneCountInString(cell))
			if col > 0 {
				line.WriteString("  ")
			}
			if right[col] {
				line.WriteString(pad + cell)
			} else {
				line.WriteString(cell + pad)
			}
		}
		lines[i] = strings.TrimRight(line.String(), " ")
	}
	return strings.Join(lines, "\r\n")
}

// pasteBullets is rows as a list in plain words: one line a row.
func pasteBullets(rows [][]string) string {
	lines := make([]string, len(rows))
	for i, row := range rows {
		lines[i] = "- " + strings.Join(row, " · ")
	}
	return strings.Join(lines, "\r\n")
}

func pasteEscape(text string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;").Replace(text)
}

// pasteHTML is rows as a table, or as a list, for a program that takes one.
// Every cell is escaped: what was read off a screen is words here, never
// markup.
func pasteHTML(rows [][]string, as string) string {
	var out strings.Builder
	if as == "list" {
		out.WriteString("<ul>")
		for _, row := range rows {
			out.WriteString("<li>" + pasteEscape(strings.Join(row, " · ")) + "</li>")
		}
		out.WriteString("</ul>")
		return out.String()
	}
	right := pasteRight(rows)
	out.WriteString(`<table style="border-collapse:collapse">`)
	for _, row := range rows {
		out.WriteString("<tr>")
		for col, cell := range row {
			style := "border:1px solid #9aa0a6;padding:4px 8px"
			if col < len(right) && right[col] {
				style += ";text-align:right"
			}
			out.WriteString(`<td style="` + style + `">` + pasteEscape(cell) + "</td>")
		}
		out.WriteString("</tr>")
	}
	out.WriteString("</table>")
	return out.String()
}

// pasteFlavours is what a paste puts on the clipboard: the plain words, the
// table or list for a program that takes one ("" when there is none), and the
// words a paste's shape is taken from.
func pasteFlavours(act notchAct) (plain, html, shape string) {
	if len(act.Rows) == 0 {
		return act.Text, "", act.Text
	}
	tsv := pasteTSV(act.Rows)
	switch act.As {
	case "cells":
		// Into a sheet: both ways of saying it are cells.
		return tsv, pasteHTML(act.Rows, "table"), tsv
	case "list":
		return pasteBullets(act.Rows), pasteHTML(act.Rows, "list"), tsv
	case "text":
		return tsv, "", tsv
	default:
		return pasteAligned(act.Rows), pasteHTML(act.Rows, "table"), tsv
	}
}

// clipHTML wraps a piece of HTML the way the Windows clipboard carries one
// ("HTML Format"): a few lines that say, in bytes from the start, where the
// HTML and the piece that matters begin and end.
func clipHTML(fragment string) []byte {
	const head = "Version:0.9\r\nStartHTML:%010d\r\nEndHTML:%010d\r\nStartFragment:%010d\r\nEndFragment:%010d\r\n"
	const before, after = "<html><body><!--StartFragment-->", "<!--EndFragment--></body></html>"
	start := len(fmt.Sprintf(head, 0, 0, 0, 0))
	fragmentStart := start + len(before)
	fragmentEnd := fragmentStart + len(fragment)
	end := fragmentEnd + len(after)
	return []byte(fmt.Sprintf(head, start, end, fragmentStart, fragmentEnd) + before + fragment + after)
}
