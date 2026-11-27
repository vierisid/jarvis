package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// The notch's window rule, as a table: what the person sees (is the window
// on screen), what the service is told (is the notch out of sight, which
// decides Esc and yes), and what a request for the keyboard gets, after each
// thing that happens to the window.
//
// The rows are Windows as it is on notch/main (notch_host_windows.go at
// 5a604f963). notchHostWindowsThen below is that code written out again
// without Win32: the same atomics, the same order. Every table runs against
// it, so a row that does not hold there is a row that is wrong about today.

// The fake window: on screen or not, and how the keyboard is handed over.
type notchFakeWin struct {
	mu      sync.Mutex
	visible bool
	shows   int
	hides   int
	// What the system answers when the page takes the keyboard.
	grants bool
	takes  int
	gives  int
}

func (f *notchFakeWin) Show() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.visible = true
	f.shows++
}

func (f *notchFakeWin) Hide() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.visible = false
	f.hides++
}

func (f *notchFakeWin) Focus(take bool) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if take {
		f.takes++
		return f.grants
	}
	f.gives++
	return false
}

func (f *notchFakeWin) seen() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.visible
}

// What the service was told, last.
type notchFakeTold struct {
	mu     sync.Mutex
	hidden bool
	times  int
}

func (s *notchFakeTold) tell(hidden bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hidden = hidden
	s.times++
}

func (s *notchFakeTold) last() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hidden
}

// A fact as the window's watch reads it.
type notchSeen struct {
	fullscreen, awake, playing, overlay bool
}

// notchHostUnderTest is what the tables drive.
type notchHostUnderTest interface {
	Loaded()
	Asking(asking bool)
	Tick(seen notchSeen)
	Focus(take bool) bool
	HasFocus() bool
	Detach()
}

// notchHostWindowsThen is notch_host_windows.go on notch/main without Win32:
// platformNotchReveal, platformNotchAsking, the rule part of watch() and
// platformNotchFocus, in their own order. The platform's half of the focus
// (who had the keyboard, the window style, SetForegroundWindow) is the fake
// window's Focus.
type notchHostWindowsThen struct {
	win      *notchFakeWin
	tell     func(hidden bool)
	gone     atomic.Bool // notchWindowFor answers nil after tear-down
	loaded   atomic.Bool
	hidden   atomic.Bool
	asking   atomic.Bool
	hasFocus atomic.Bool
}

func (w *notchHostWindowsThen) Loaded() {
	if w.gone.Load() {
		return
	}
	w.loaded.Store(true)
	w.asking.Store(false)
	w.tell(w.hidden.Load())
	if !w.hidden.Load() {
		w.win.Show()
	}
}

func (w *notchHostWindowsThen) Asking(asking bool) {
	if w.gone.Load() {
		return
	}
	if w.asking.Swap(asking) == asking || !asking {
		return
	}
	if w.hidden.CompareAndSwap(true, false) {
		w.tell(false)
		if w.loaded.Load() {
			w.win.Show()
		}
	}
}

func (w *notchHostWindowsThen) Tick(seen notchSeen) {
	if w.gone.Load() {
		// The watch returns once the window is gone.
		return
	}
	if seen.fullscreen && seen.overlay {
		// A screen capture in progress: `continue`.
		return
	}
	playing := seen.fullscreen && seen.awake && seen.playing
	hide := notchShouldHide(seen.fullscreen, seen.awake, playing, w.asking.Load())
	if hide != w.hidden.Load() {
		w.hidden.Store(hide)
		w.tell(hide)
		if hide {
			w.win.Hide()
		} else if w.loaded.Load() {
			w.win.Show()
		}
	}
}

func (w *notchHostWindowsThen) Focus(take bool) bool {
	if w.gone.Load() {
		return false
	}
	if take && w.hidden.Load() {
		return false
	}
	if take {
		w.hasFocus.Store(true)
		got := w.win.Focus(true)
		if !got {
			w.hasFocus.Store(false)
		}
		return got
	}
	w.hasFocus.Store(false)
	w.win.Focus(false)
	return false
}

func (w *notchHostWindowsThen) HasFocus() bool { return w.hasFocus.Load() }

func (w *notchHostWindowsThen) Detach() { w.gone.Store(true) }

// One thing that happens, and what must hold after it.
type notchHostStep struct {
	do string // "load", "ask", "unask", "tick", "take", "give", "detach"
	// For a tick: what the watch sees.
	seen notchSeen
	// For "take": what the system answers.
	grants bool
	// After the step.
	visible bool
	hidden  bool // what the service was told last
	focus   bool // for "take": what the page is answered
	has     bool // the notch holds the keyboard it asked for
}

var (
	notchFilm      = notchSeen{fullscreen: true, awake: true, playing: true}
	notchReading   = notchSeen{fullscreen: true}
	notchDesk      = notchSeen{}
	notchCapture   = notchSeen{fullscreen: true, overlay: true}
	notchHeldStill = notchSeen{fullscreen: true, awake: true} // display held, picture still
)

var notchHostTables = []struct {
	name  string
	steps []notchHostStep
}{
	{"a page that loads on the desktop is shown", []notchHostStep{
		{do: "tick", seen: notchDesk},
		{do: "load", visible: true},
		{do: "tick", seen: notchDesk, visible: true},
	}},
	{"nothing is shown before the page has loaded, and a film then keeps it away", []notchHostStep{
		{do: "tick", seen: notchFilm, hidden: true},
		{do: "load", hidden: true},
		{do: "tick", seen: notchFilm, hidden: true},
		{do: "tick", seen: notchDesk, visible: true},
	}},
	{"a film hides it, the desktop brings it back", []notchHostStep{
		{do: "load", visible: true},
		{do: "tick", seen: notchFilm, hidden: true},
		{do: "tick", seen: notchFilm, hidden: true},
		{do: "tick", seen: notchDesk, visible: true},
	}},
	{"only a film hides it", []notchHostStep{
		{do: "load", visible: true},
		{do: "tick", seen: notchReading, visible: true},
		{do: "tick", seen: notchHeldStill, visible: true},
		{do: "tick", seen: notchSeen{awake: true, playing: true}, visible: true},
		{do: "tick", seen: notchSeen{fullscreen: true, playing: true}, visible: true},
	}},
	{"a question brings it back over the film, and the film takes it again once answered", []notchHostStep{
		{do: "load", visible: true},
		{do: "tick", seen: notchFilm, hidden: true},
		{do: "ask", visible: true},
		{do: "tick", seen: notchFilm, visible: true},
		{do: "ask", visible: true},
		{do: "unask", visible: true}, // until the next look
		{do: "tick", seen: notchFilm, hidden: true},
	}},
	{"a question asked in sight keeps it in sight when a film starts", []notchHostStep{
		{do: "load", visible: true},
		{do: "ask", visible: true},
		{do: "tick", seen: notchFilm, visible: true},
		{do: "unask", visible: true},
		{do: "tick", seen: notchFilm, hidden: true},
	}},
	{"a page that loads asks nothing yet", []notchHostStep{
		{do: "ask"},
		{do: "load", visible: true},
		{do: "tick", seen: notchFilm, hidden: true},
	}},
	{"a screen capture leaves it as it was", []notchHostStep{
		{do: "load", visible: true},
		{do: "tick", seen: notchCapture, visible: true},
		{do: "tick", seen: notchFilm, hidden: true},
		{do: "tick", seen: notchCapture, hidden: true},
		{do: "tick", seen: notchDesk, visible: true},
	}},
	{"a hidden notch does not take the keyboard", []notchHostStep{
		{do: "load", visible: true},
		{do: "tick", seen: notchFilm, hidden: true},
		{do: "take", grants: true, hidden: true, focus: false, has: false},
		{do: "ask", visible: true},
		{do: "take", grants: true, visible: true, focus: true, has: true},
		{do: "give", visible: true},
	}},
	{"the keyboard taken, refused, and given back", []notchHostStep{
		{do: "load", visible: true},
		{do: "take", grants: false, visible: true, focus: false, has: false},
		{do: "take", grants: true, visible: true, focus: true, has: true},
		{do: "tick", seen: notchDesk, visible: true, has: true},
		{do: "give", visible: true, has: false},
	}},
	{"after the window is gone nothing moves", []notchHostStep{
		{do: "load", visible: true},
		{do: "detach", visible: true},
		{do: "tick", seen: notchFilm, visible: true},
		{do: "take", grants: true, visible: true, focus: false},
	}},
}

func notchHostRun(t *testing.T, build func(win *notchFakeWin, told *notchFakeTold) notchHostUnderTest) {
	t.Helper()
	for _, table := range notchHostTables {
		t.Run(table.name, func(t *testing.T) {
			win := &notchFakeWin{}
			told := &notchFakeTold{}
			host := build(win, told)
			for i, step := range table.steps {
				where := fmt.Sprintf("step %d (%s %+v)", i, step.do, step.seen)
				focus := false
				switch step.do {
				case "load":
					host.Loaded()
				case "ask":
					host.Asking(true)
				case "unask":
					host.Asking(false)
				case "tick":
					host.Tick(step.seen)
				case "take":
					win.mu.Lock()
					win.grants = step.grants
					win.mu.Unlock()
					focus = host.Focus(true)
				case "give":
					focus = host.Focus(false)
				case "detach":
					host.Detach()
				default:
					t.Fatalf("%s: no such step", where)
				}
				if got := win.seen(); got != step.visible {
					t.Errorf("%s: on screen %v, want %v", where, got, step.visible)
				}
				if got := told.last(); got != step.hidden {
					t.Errorf("%s: the service was told hidden=%v, want %v", where, got, step.hidden)
				}
				if focus != step.focus {
					t.Errorf("%s: the page was answered %v, want %v", where, focus, step.focus)
				}
				if got := host.HasFocus(); got != step.has {
					t.Errorf("%s: holds the keyboard %v, want %v", where, got, step.has)
				}
			}
		})
	}
}

// The tables hold of Windows as it was.
func TestNotchHostTablesHoldOfWindowsThen(t *testing.T) {
	notchHostRun(t, func(win *notchFakeWin, told *notchFakeTold) notchHostUnderTest {
		return &notchHostWindowsThen{win: win, tell: told.tell}
	})
}

// A hidden notch never asks the system for the keyboard: the film keeps it.
func TestNotchHostThenHiddenNeverAsksTheSystem(t *testing.T) {
	win := &notchFakeWin{grants: true}
	told := &notchFakeTold{}
	w := &notchHostWindowsThen{win: win, tell: told.tell}
	w.Loaded()
	w.Tick(notchFilm)
	w.Focus(true)
	if win.takes != 0 {
		t.Fatalf("the system was asked %d times", win.takes)
	}
}
