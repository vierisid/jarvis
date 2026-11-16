//go:build darwin

package main

// Watching what the hands do, and doing a step again, on the Mac
// (notch_watch.go says what both are for).
//
// NOT YET RUN. Written on a machine that cannot build for macOS; GitHub's Mac
// job compiles it and nothing more. It is to be tried by hand in pass 14 with
// everything else on the Mac.
//
// The watching is an event tap that sees the mouse buttons and the keys and
// keeps none of them. It is in for two things, which share it:
//
//   - a recording ("Watch me"): what is clicked is read from the program it
//     is in, what is typed is read from its field when the field is left, and
//     named keys and shortcuts are steps. The Mac had no recorder before.
//   - the notch watching by itself: the shape of what is done and nothing
//     else (a window, a place in it, a named key).
//
// Which key it was is decided in C, before Go is woken: a key that types is
// handed over as "a key that types" with no key in it, and its letter is only
// read off the event while Cmd or Ctrl is held. So nothing a person writes
// can be learned from what crosses into Go.
//
// Doing a step again presses with events posted to the system, as a hand
// would. A posted press carries the poster's process id, and the tap passes
// such events over: what Jarvis does is never taken for what the person did.

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework ApplicationServices

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <unistd.h>

extern void goNotchWatchMouse(int kind, int x, int y, int mods);
extern void goNotchWatchKey(int code, int letter, int mods, int repeat);

static CFMachPortRef jarvis_watch_tap = NULL;
static CFRunLoopSourceRef jarvis_watch_tap_source = NULL;

// 1 Ctrl, 2 Option, 4 Cmd, 8 Shift.
static int jarvis_watch_mods(CGEventFlags flags) {
	int mods = 0;
	if (flags & kCGEventFlagMaskControl) mods |= 1;
	if (flags & kCGEventFlagMaskAlternate) mods |= 2;
	if (flags & kCGEventFlagMaskCommand) mods |= 4;
	if (flags & kCGEventFlagMaskShift) mods |= 8;
	return mods;
}

// Whether a key has a name of its own: Return, Tab, the arrows and their
// kind, the function keys. These are steps whatever is held with them.
static int jarvis_watch_named(int64_t code) {
	switch (code) {
		case 36: case 76: case 48: case 117: case 114:
		case 116: case 121: case 119: case 115:
		case 123: case 124: case 125: case 126:
		case 122: case 120: case 99: case 118: case 96: case 97:
		case 98: case 100: case 101: case 109: case 103: case 111:
			return 1;
	}
	return 0;
}

static CGEventRef jarvis_watch_tap_callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
	if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
		if (jarvis_watch_tap != NULL) CGEventTapEnable(jarvis_watch_tap, true);
		return event;
	}
	// What a program posted is not what the person did: Jarvis's own presses above all.
	if (CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID) != 0) return event;
	CGEventFlags flags = CGEventGetFlags(event);
	int mods = jarvis_watch_mods(flags);
	if (type == kCGEventLeftMouseDown || type == kCGEventLeftMouseUp) {
		CGPoint p = CGEventGetLocation(event);
		goNotchWatchMouse(type == kCGEventLeftMouseDown ? 1 : 2, (int)p.x, (int)p.y, mods);
		return event;
	}
	if (type != kCGEventKeyDown) return event;
	int64_t code = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
	int repeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0 ? 1 : 0;
	int chord = (flags & (kCGEventFlagMaskCommand | kCGEventFlagMaskControl)) != 0;
	if (code == 53) {
		// Esc is the notch's own, and no step.
		return event;
	}
	if (jarvis_watch_named(code)) {
		goNotchWatchKey((int)code, 0, mods, repeat);
		return event;
	}
	if (!chord) {
		// A key that types. Which one is not looked at, and not handed on.
		goNotchWatchKey(-1, 0, mods, repeat);
		return event;
	}
	// A shortcut: the letter or digit it is made with, and nothing else. With
	// Ctrl held the system gives the letter as its place in the alphabet.
	int letter = 0;
	UniChar chars[4];
	UniCharCount n = 0;
	CGEventKeyboardGetUnicodeString(event, 4, &n, chars);
	if (n == 1) {
		UniChar c = chars[0];
		if (c >= 1 && c <= 26) c = (UniChar)('a' + c - 1);
		if (c >= 'A' && c <= 'Z') c = (UniChar)(c - 'A' + 'a');
		if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) letter = (int)c;
	}
	// Backspace and Space are told by their key, for Cmd + Backspace and the like.
	goNotchWatchKey((code == 51 || code == 49) ? (int)code : -2, letter, mods, repeat);
	return event;
}

// Returns 1 when the tap is in, 0 when the system refused it.
static int jarvis_watch_tap_start(void) {
	if (jarvis_watch_tap != NULL) return 1;
	CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) | CGEventMaskBit(kCGEventKeyDown);
	// An active tap that keeps nothing: that is the kind the Accessibility
	// permission covers, which this program already has for the notch's keys.
	CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap, kCGEventTapOptionDefault,
		mask, jarvis_watch_tap_callback, NULL);
	if (tap == NULL) return 0;
	CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
	if (source == NULL) {
		CFRelease(tap);
		return 0;
	}
	jarvis_watch_tap = tap;
	jarvis_watch_tap_source = source;
	CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
	CGEventTapEnable(tap, true);
	CFRunLoopWakeUp(CFRunLoopGetMain());
	return 1;
}

static void jarvis_watch_tap_stop(void) {
	CFMachPortRef tap = jarvis_watch_tap;
	CFRunLoopSourceRef source = jarvis_watch_tap_source;
	jarvis_watch_tap = NULL;
	jarvis_watch_tap_source = NULL;
	if (tap != NULL) CGEventTapEnable(tap, false);
	if (source != NULL) {
		CFRunLoopRemoveSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
		CFRelease(source);
	}
	if (tap != NULL) {
		CFMachPortInvalidate(tap);
		CFRelease(tap);
	}
}

// 1 when this program is the one in front: the notch has the keyboard, and
// what is typed or pressed is said to it, not done in another app.
static int jarvis_watch_front_is_own(void) {
	__block int own = 0;
	void (^ask)(void) = ^{
		NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
		own = (app != nil && app.processIdentifier == getpid()) ? 1 : 0;
	};
	if ([NSThread isMainThread]) ask(); else dispatch_sync(dispatch_get_main_queue(), ask);
	return own;
}
*/
import "C"

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func init() {
	inputHookStart = macStartRecording
	inputHookStop = macStopRecording
	notchWatchSet = macSetWatching
	platformNotchAct = notchActMac
}

// macWatchEvent is one thing the tap saw, on its way to the worker.
type macWatchEvent struct {
	// down, up, key, record_end
	kind string
	at   lookPoint
	mods watchMods
	// key: the key's code when it has a name, -1 for a key that types, -2 for
	// a shortcut on a letter or a digit (then letter says which).
	code   int
	letter byte
	repeat bool
	// What the tap was in for when this happened. A recording comes first.
	rec, watch bool
}

var (
	// Why the tap is in. Either or both. Read on every event.
	macRecording atomic.Bool
	macWatching  atomic.Bool

	// Under macHookMu: whether the tap is in.
	macHookMu sync.Mutex
	macHookIn bool

	// What the tap saw, on its way to the worker, which is started with the
	// first use. Made once, so that the tap never has to wait for a lock to
	// find it.
	macHookEvents = make(chan macWatchEvent, 64)
	macHookWorker sync.Once
)

// macHooksWanted puts the tap in when either use wants it and takes it out
// when neither does. With macHookMu held.
func macHooksWanted() error {
	want := macRecording.Load() || macWatching.Load()
	if want == macHookIn {
		return nil
	}
	if !want {
		C.jarvis_watch_tap_stop()
		macHookIn = false
		return nil
	}
	if !macAXTrusted() {
		return fmt.Errorf("watching needs the Accessibility permission (System Settings, Privacy & Security, Accessibility); grant it and start Jarvis again")
	}
	macHookWorker.Do(func() { go macWatchWorker(macHookEvents) })
	if C.jarvis_watch_tap_start() == 0 {
		return fmt.Errorf("the system refused the tap that watches the mouse and the keys")
	}
	macHookIn = true
	return nil
}

func macStartRecording() error {
	macHookMu.Lock()
	defer macHookMu.Unlock()
	macRecording.Store(true)
	if err := macHooksWanted(); err != nil {
		macRecording.Store(false)
		return err
	}
	return nil
}

func macStopRecording() {
	macHookMu.Lock()
	defer macHookMu.Unlock()
	macRecording.Store(false)
	// The field that was being typed into is let go: the tap may stay in, for the notch.
	select {
	case macHookEvents <- macWatchEvent{kind: "record_end"}:
	default:
	}
	_ = macHooksWanted()
}

func macSetWatching(on bool) error {
	macHookMu.Lock()
	defer macHookMu.Unlock()
	macWatching.Store(on)
	if err := macHooksWanted(); err != nil {
		macWatching.Store(false)
		return err
	}
	return nil
}

func macModsOf(bits int) watchMods {
	return watchMods{Ctrl: bits&1 != 0, Alt: bits&2 != 0, Cmd: bits&4 != 0, Shift: bits&8 != 0}
}

// macWatchSend hands an event to the worker and never waits: the tap is on
// the main thread, and every key and click on the machine goes through it.
func macWatchSend(e macWatchEvent) {
	e.rec, e.watch = macRecording.Load(), macWatching.Load()
	if !e.rec && !e.watch {
		return
	}
	select {
	case macHookEvents <- e:
	default:
		// A dropped event is a missed step the person can show again; a stall is not.
	}
}

func macWatchMouse(kind, x, y, mods int) {
	which := "up"
	if kind == 1 {
		which = "down"
	}
	macWatchSend(macWatchEvent{kind: which, at: lookPoint{x, y}, mods: macModsOf(mods)})
}

func macWatchKey(code, letter, mods int, repeat bool) {
	macWatchSend(macWatchEvent{kind: "key", code: code, letter: byte(letter), mods: macModsOf(mods), repeat: repeat})
}

// macWatchWindow is a window as a step names it.
func macWatchWindow(win macWin) watchWindow {
	return watchWindow{ID: fmt.Sprintf("0x%x", win.ID), Pid: uint32(win.Pid), App: win.App, W: win.Rect.W, H: win.Rect.H}
}

// macWatchState is what the worker keeps between events. It is the worker's
// alone.
type macWatchState struct {
	flow watchFlow
	// Where the button last went down: the window there, and whether that was
	// one of this program's own.
	down struct {
		at      lookPoint
		win     macWin
		ok, own bool
		sampled bool
	}
	// A recording: typing has begun in a field, which is held until it is left.
	typing  bool
	field   macElem
	fieldIn macWin
	// The notch watching by itself was told "typed" and has seen no step since.
	toldTyped bool
}

// looksAt says whether this program looks at a window now. Where it does
// not, the brain hears "gap" once and nothing else.
func (s *macWatchState) looksAt(win macWin) bool {
	if why := notchLookAway(notchAppKey(win.App), win.Title); why != "" {
		if s.flow.Away() {
			recorderEmit(notchWatchEvent, map[string]any{"kind": "gap", "ts": time.Now().UnixMilli()})
		}
		return false
	}
	s.flow.Looking()
	return true
}

// macWatchWorker takes what the tap saw, in order, and does the reading the
// tap could not afford to.
func macWatchWorker(events <-chan macWatchEvent) {
	state := &macWatchState{}
	for e := range events {
		switch e.kind {
		case "record_end":
			state.dropField()
		case "down":
			// The window is read at the press, not at the release: a press can
			// close what was pressed, and bring another window up under it.
			state.down.at = e.at
			state.down.own = macOwnAt(e.at)
			state.down.win, state.down.ok = macWinAt(e.at)
			state.down.sampled = true
			if e.rec && state.typing {
				state.flushField()
			}
		case "up":
			site := state.down
			state.down.sampled = false
			if !pressSiteStillApplies(site.at.X, site.at.Y, site.sampled, e.at.X, e.at.Y) {
				// A drag, or a release whose press was not seen: where it was let go is what is meant.
				site.at = e.at
				site.own = macOwnAt(e.at)
				site.win, site.ok = macWinAt(e.at)
			}
			// A click on the notch itself is not part of any job.
			if site.own || !site.ok {
				continue
			}
			state.toldTyped = false
			if e.rec {
				state.recordClick(site.at, site.win, watchClickMods(e.mods))
			} else if e.watch {
				state.tellClick(site.at, site.win, watchClickMods(e.mods))
			}
		case "key":
			state.key(e)
		}
	}
}

func (s *macWatchState) key(e macWatchEvent) {
	// Said to the notch, not done in another app.
	if C.jarvis_watch_front_is_own() == 1 {
		return
	}
	kind, spec := watchKeyTyped, ""
	if e.code != -1 {
		code := e.code
		if code == -2 {
			code = -1
		}
		kind, spec = watchKeyMac(code, e.letter, e.mods)
	}
	switch kind {
	case watchKeyStep:
		// A shortcut that is held repeats itself: it was told when it went down.
		if e.repeat && (e.mods.Cmd || e.mods.Ctrl) {
			return
		}
		win, ok := macWinFront()
		if !ok {
			return
		}
		if e.rec {
			if (spec == "enter" || spec == "tab") && s.typing {
				s.flushField()
			}
			s.recordKeys(win, spec)
		} else if e.watch && s.looksAt(win) {
			s.flow.Step()
			s.toldTyped = false
			recorderEmit(notchWatchEvent, watchKeysPayload(macWatchWindow(win), spec, time.Now().UnixMilli()))
		}
	case watchKeyTyped:
		if e.rec {
			if !s.typing {
				s.startField()
			}
			return
		}
		if !e.watch || s.toldTyped {
			return
		}
		win, ok := macWinFront()
		if !ok || !s.looksAt(win) {
			return
		}
		s.toldTyped = true
		if s.flow.Typed() {
			recorderEmit(notchWatchEvent, map[string]any{"kind": "typed", "ts": time.Now().UnixMilli()})
		}
	}
}

// tellClick tells the brain the shape of a click: the window, and the place in it.
func (s *macWatchState) tellClick(at lookPoint, win macWin, mods string) {
	if !s.looksAt(win) {
		return
	}
	s.flow.Step()
	recorderEmit(notchWatchEvent, watchClickPayload(macWatchWindow(win), at.X-win.Rect.X, at.Y-win.Rect.Y, mods, time.Now().UnixMilli()))
}

// macPath is what a thing stands in, from the window down to its nearest
// container, as the recorder writes a path.
func macPath(e macElem) []map[string]any {
	var up []map[string]any
	cur, ok := macElemParent(e, true)
	for climb := 0; ok; climb++ {
		up = append(up, map[string]any{"role": cur.kind, "name": truncateRunes(cur.name, 40)})
		if cur.kind == "Window" || climb >= 11 {
			cur.release()
			break
		}
		next, more := macElemParent(cur, true)
		cur.release()
		cur, ok = next, more
	}
	path := make([]map[string]any, 0, len(up))
	for i := len(up) - 1; i >= 0; i-- {
		path = append(path, up[i])
	}
	return path
}

// macRef is a thing as a recorded step names it.
func macRef(e macElem) map[string]any {
	name := truncateRunes(e.name, 100)
	path := macPath(e)
	return map[string]any{
		"role": e.kind, "name": name, "stableId": "", "path": path, "ordinal": 0,
		"sig": semanticSig(e.kind, name, "", path, 0),
	}
}

func macInteraction(win macWin, action string) map[string]any {
	payload := map[string]any{"surface": "desktop", "ts": time.Now().UnixMilli(), "secure": false, "action": action}
	if win.App != "" {
		payload["app"] = win.App
	}
	if win.Title != "" {
		payload["title"] = win.Title
	}
	if win.ID != 0 {
		payload["win"] = macWatchWindow(win).payload()
	}
	return payload
}

// recordClick tells a click made during a recording: the thing that was
// clicked, as the program it is in describes it, and where in its window.
func (s *macWatchState) recordClick(at lookPoint, win macWin, mods string) {
	// A moment for the click to have done what it does, as on Windows.
	time.Sleep(60 * time.Millisecond)
	found, ok := macFound(at)
	if !ok {
		log.Printf("[recorder] dropped a click: the program it was in said nothing about what is there")
		return
	}
	defer found.release()
	payload := macInteraction(win, "click")
	payload["secure"] = found.secure
	payload["ref"] = macRef(found)
	payload["pt"] = map[string]any{"x": at.X - win.Rect.X, "y": at.Y - win.Rect.Y}
	if mods != "" {
		payload["mods"] = mods
	}
	// The kind of thing, never its name: a name is something read off the screen.
	log.Printf("[recorder] click: a %s", found.kind)
	emitInteraction(payload)
}

// recordKeys tells a named key or a shortcut pressed during a recording.
func (s *macWatchState) recordKeys(win macWin, keys string) {
	payload := macInteraction(win, "press_keys")
	payload["value"] = keys
	log.Printf("[recorder] press_keys: %s", keys)
	emitInteraction(payload)
}

// startField remembers the thing that has the keyboard at the first key that
// types, so that what it holds can be read when it is left.
func (s *macWatchState) startField() {
	win, ok := macWinFront()
	if !ok {
		return
	}
	field, ok := macFocusedElem(win.Pid, true)
	if !ok {
		return
	}
	s.dropField()
	s.typing, s.field, s.fieldIn = true, field, win
}

func (s *macWatchState) dropField() {
	if s.typing {
		s.field.release()
	}
	s.typing = false
	s.field = macElem{}
}

// flushField tells what was typed into the field that is being left: what
// the field holds now, read from the program. What is typed into a password
// field is never read, and is told as a field with no value.
func (s *macWatchState) flushField() {
	if !s.typing {
		return
	}
	field, win := s.field, s.fieldIn
	s.typing = false
	s.field = macElem{}
	defer field.release()
	payload := macInteraction(win, "set_value")
	payload["secure"] = field.secure
	payload["ref"] = macRef(field)
	if !field.secure {
		if full, ok := macElemOf(field.ref, false); ok {
			payload["value"] = full.value
		}
	}
	log.Printf("[recorder] set_value: a %s (secure=%v)", field.kind, field.secure)
	emitInteraction(payload)
}

// ---------------------------------------------------------------------------
// notch.act
// ---------------------------------------------------------------------------

// One thing at a time: two jobs do not share the pointer.
var macActMu sync.Mutex

// macActWindow finds the window a step named, as it is now. It refuses a
// window that is gone or put away, or whose number another program now has.
func macActWindow(act notchAct) (macWin, *notchActError) {
	var id uint32
	if _, err := fmt.Sscanf(act.Win.ID, "0x%x", &id); err != nil || id == 0 {
		return macWin{}, &notchActError{"gone", "the window is not named as a step names one"}
	}
	win, ok := macWinByID(id)
	if !ok || uint32(win.Pid) != act.Win.Pid {
		return macWin{}, &notchActError{"gone", "the window is not there any more"}
	}
	return win, nil
}

// macActFront waits a moment for a window to be the one the person is in: a
// click that brings a window forward is answered a little before it is there.
func macActFront(id uint32) bool {
	for try := 0; try < 30; try++ {
		if front, ok := macWinFront(); ok && front.ID == id {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// macActPress sends Jarvis's pointer to a place and presses there. want is
// the window the press is meant for, or 0 for whatever is at the place.
func macActPress(act notchAct, at lookPoint, want uint32) *notchActError {
	if macOwnAt(at) {
		return &notchActError{"own", "one of Jarvis's own windows is at that place"}
	}
	under, ok := macWinAt(at)
	switch {
	case !ok:
		return &notchActError{"outside", "there is no window at that place"}
	case want != 0 && under.ID != want:
		return &notchActError{"covered", "another window is over that place"}
	}
	if hands := notchActHands(); hands != nil {
		// The pointer is seen to land before anything happens there.
		if took := hands.HandTo(act.Hand, at, false); took > 0 {
			time.Sleep(took + 40*time.Millisecond)
		}
	}
	// A sheet of Jarvis's own can have come up there meanwhile.
	if macOwnAt(at) {
		return &notchActError{"own", "one of Jarvis's own windows came up at that place"}
	}
	macClick(at, act.Mods, act.Double)
	return nil
}

// macActKeysIn presses keys in a window a step named: only when that window
// is the one the person is in, because the keys go to whatever is.
func macActKeysIn(act notchAct, keys string) *notchActError {
	win, refusal := macActWindow(act)
	if refusal != nil {
		return refusal
	}
	if !macActFront(win.ID) {
		return &notchActError{"front", "another window is in front"}
	}
	if err := macPressKeys(keys); err != nil {
		return &notchActError{"failed", err.Error()}
	}
	return nil
}

func notchActMac(act notchAct) (*RPCResult, error) {
	if !macAXTrusted() {
		return nil, fmt.Errorf("notch.act: the Accessibility permission is not given")
	}
	macActMu.Lock()
	defer macActMu.Unlock()
	done := func(more map[string]any) (*RPCResult, error) {
		result := map[string]any{"done": true}
		for key, value := range more {
			result[key] = value
		}
		return &RPCResult{Result: result}, nil
	}
	refuse := func(err *notchActError) (*RPCResult, error) {
		// The word, never a place or a name.
		log.Printf("[notch] act: %s was not done: %s", act.Do, err.Why)
		return notchActRefusal(err), nil
	}
	// place is where a step lands on the screen, and the window it is meant for (0 for none).
	place := func() (lookPoint, uint32, *notchActError) {
		rect, want := lookRect{}, uint32(0)
		if !act.Screen {
			win, refusal := macActWindow(act)
			if refusal != nil {
				return lookPoint{}, 0, refusal
			}
			rect, want = win.Rect, win.ID
		}
		at, err := notchActPlace(act, rect)
		if err != nil {
			return lookPoint{}, 0, err.(*notchActError)
		}
		return at, want, nil
	}
	switch act.Do {
	case "home":
		if hands := notchActHands(); hands != nil {
			hands.HandsHome()
		}
		return done(nil)

	case "front":
		win, ok := macWinFront()
		if !ok {
			return refuse(&notchActError{"gone", "no window is in front"})
		}
		return done(map[string]any{"win": macWatchWindow(win).payload(), "app": win.App})

	case "find":
		// The window a step named, as it is now; or, when its program was
		// started again since, that program's topmost window of the same size.
		same := func(win macWin) bool {
			return absInt(win.Rect.W-act.Win.W) <= 2 && absInt(win.Rect.H-act.Win.H) <= 2
		}
		if win, refusal := macActWindow(act); refusal == nil && same(win) {
			return done(map[string]any{"win": macWatchWindow(win).payload(), "app": win.App})
		}
		if win, ok := macWinFind(act.App, act.Win.W, act.Win.H); ok {
			return done(map[string]any{"win": macWatchWindow(win).payload(), "app": win.App})
		}
		return refuse(&notchActError{"gone", "no window of that program is there at that size"})

	case "hand":
		hands := notchActHands()
		if hands == nil {
			return refuse(&notchActError{"failed", "no pointer here"})
		}
		var at lookPoint
		if act.Beside && !act.Screen && act.Win.ID == "" {
			here := macPointer()
			at = lookPoint{here.X + 18, here.Y + 14}
		} else {
			var refusal *notchActError
			if at, _, refusal = place(); refusal != nil {
				return refuse(refusal)
			}
		}
		took := hands.HandTo(act.Hand, at, act.Beside)
		return done(map[string]any{"ms": took.Milliseconds()})

	case "count":
		hands := notchActHands()
		win, refusal := macActWindow(act)
		if refusal != nil {
			return refuse(refusal)
		}
		// Where this program looks away it does not count either.
		if hands == nil || notchLookAway(notchAppKey(win.App), win.Title) != "" {
			return done(map[string]any{"known": false, "left": 0})
		}
		left, known := watchCountLeft(func(k int) (lookThing, bool) {
			x, y := act.X+k*act.Dx, act.Y+k*act.Dy
			if x < 0 || y < 0 || x >= win.Rect.W || y >= win.Rect.H {
				return lookThing{}, false
			}
			return hands.ThingAt(lookPoint{win.Rect.X + x, win.Rect.Y + y}, false)
		}, act.Most)
		log.Printf("[notch] act: counted what is left: %d (could tell: %v)", left, known)
		return done(map[string]any{"known": known, "left": left})

	case "pitch":
		// How far apart the rows really are at a place, read from the screen
		// (watchPitch). A number leaves this function, and nothing else.
		win, refusal := macActWindow(act)
		if refusal != nil {
			return refuse(refusal)
		}
		unknown := map[string]any{"known": false, "dy": 0}
		if notchLookAway(notchAppKey(win.App), win.Title) != "" {
			return done(unknown)
		}
		at, err := notchActPlace(act, win.Rect)
		if err != nil {
			return refuse(err.(*notchActError))
		}
		strip := watchStrip(win.Rect, at, float64(act.Dy))
		// One pixel to a point, so that what is measured is in the points every place is counted in.
		shot := macCapture(strip, true)
		if shot == nil {
			return done(unknown)
		}
		pixels, width, height := shot.pixels()
		shot.close()
		exact, ok := watchPitch(watchProfile(pixels, width, height), float64(act.Dy))
		if !ok {
			log.Printf("[notch] act: no rows could be seen at that place")
			return done(unknown)
		}
		if act.Dy < 0 {
			exact = -exact
		}
		log.Printf("[notch] act: the rows there are %.2f points apart a step (the hand went %d)", exact, act.Dy)
		return done(map[string]any{"known": true, "dy": exact})

	case "click":
		at, want, refusal := place()
		if refusal != nil {
			return refuse(refusal)
		}
		if refusal := macActPress(act, at, want); refusal != nil {
			return refuse(refusal)
		}
		return done(nil)

	case "keys":
		if refusal := macActKeysIn(act, act.Keys); refusal != nil {
			return refuse(refusal)
		}
		return done(nil)

	case "type":
		// Words typed where the keyboard is, in the window they were typed in when the job was shown.
		win, refusal := macActWindow(act)
		if refusal != nil {
			return refuse(refusal)
		}
		if !macActFront(win.ID) {
			return refuse(&notchActError{"front", "another window is in front"})
		}
		macType(act.Text)
		return done(nil)

	case "copy":
		// What is selected is copied, and only its shape is told. The
		// clipboard is emptied first, so that "nothing was copied" is not
		// mistaken for the last thing that was.
		for i := 0; i < act.Right; i++ {
			if refusal := macActKeysIn(act, "shift,right"); refusal != nil {
				return refuse(refusal)
			}
		}
		for i := 0; i < act.Down; i++ {
			if refusal := macActKeysIn(act, "shift,down"); refusal != nil {
				return refuse(refusal)
			}
		}
		if act.Right+act.Down > 0 {
			time.Sleep(60 * time.Millisecond)
		}
		if !macClipClear() {
			return refuse(&notchActError{"failed", "the clipboard could not be emptied"})
		}
		before := macClipCount()
		keys := act.Keys
		if keys == "" || keys == "ctrl,c" {
			// On a Mac a copy is Cmd + C, whatever the job that asks for one was shown on.
			keys = "cmd,c"
		}
		if refusal := macActKeysIn(act, keys); refusal != nil {
			return refuse(refusal)
		}
		text := ""
		for try := 0; try < 36; try++ {
			time.Sleep(25 * time.Millisecond)
			if macClipCount() == before {
				continue
			}
			if got, ok := macClipText(); ok {
				text = got
			}
			break
		}
		return done(clipShapeOf(text).payload())

	case "paste":
		plain, html, shape := pasteFlavours(act)
		// A Mac's line ends are one sign, not two.
		plain = strings.ReplaceAll(plain, "\r\n", "\n")
		if act.Front {
			// Where the person already is: at the caret of the window in front, with no click first.
			front, ok := macWinFront()
			if !ok {
				return refuse(&notchActError{"gone", "no window is in front"})
			}
			if !macClipSet(plain, html) {
				return refuse(&notchActError{"failed", "the clipboard could not be written"})
			}
			if err := macPressKeys("cmd,v"); err != nil {
				return refuse(&notchActError{"failed", err.Error()})
			}
			time.Sleep(120 * time.Millisecond)
			return done(map[string]any{"win": macWatchWindow(front).payload(), "app": front.App, "shape": clipShapeOf(shape).payload()})
		}
		at, want, refusal := place()
		if refusal != nil {
			return refuse(refusal)
		}
		before, had := macClipText()
		if !macClipSet(plain, html) {
			return refuse(&notchActError{"failed", "the clipboard could not be written"})
		}
		restore := func() {
			if had {
				macClipSet(before, "")
			} else {
				macClipClear()
			}
		}
		if refusal := macActPress(act, at, want); refusal != nil {
			restore()
			return refuse(refusal)
		}
		target, ok := macWinAt(at)
		if !ok || !macActFront(target.ID) {
			restore()
			return refuse(&notchActError{"front", "the window at that place did not come to the front"})
		}
		time.Sleep(80 * time.Millisecond)
		if err := macPressKeys("cmd,v"); err != nil {
			restore()
			return refuse(&notchActError{"failed", err.Error()})
		}
		// What was put stays on the clipboard (see the Windows side for why).
		time.Sleep(120 * time.Millisecond)
		return done(map[string]any{
			"win": macWatchWindow(target).payload(), "app": target.App,
			"pt":    map[string]any{"x": at.X - target.Rect.X, "y": at.Y - target.Rect.Y},
			"shape": clipShapeOf(shape).payload(),
		})
	}
	return nil, fmt.Errorf("notch.act: do must be click, keys, type, copy, paste, hand, home, front, find, count or pitch")
}
