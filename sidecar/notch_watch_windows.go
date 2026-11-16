//go:build windows

package main

// Watching by itself, and doing a step again: the Windows part (notch_watch.go).
//
// The hooks are the recorder's (recorder_windows.go). What they see is told
// here as shapes. Doing a step again uses the system's own pointer for the
// press, because that is the only press every program takes; it is put back
// where the person had it in the same breath. Jarvis's own pointer, which is
// a picture, goes to the place first.

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	procOpenClipboard     = user32.NewProc("OpenClipboard")
	procCloseClipboard    = user32.NewProc("CloseClipboard")
	procEmptyClipboard    = user32.NewProc("EmptyClipboard")
	procGetClipboardData  = user32.NewProc("GetClipboardData")
	procSetClipboardData  = user32.NewProc("SetClipboardData")
	procClipboardHasFmt   = user32.NewProc("IsClipboardFormatAvailable")
	procWatchGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	procWatchGlobalLock   = kernel32.NewProc("GlobalLock")
	procWatchGlobalUnlock = kernel32.NewProc("GlobalUnlock")
	procWatchGlobalFree   = kernel32.NewProc("GlobalFree")
	procWatchGlobalSize   = kernel32.NewProc("GlobalSize")
	procRegisterClipFmtW  = user32.NewProc("RegisterClipboardFormatW")
)

const (
	cfUnicodeText = 13
	gmemMoveable  = 0x0002
)

func init() {
	platformNotchAct = notchActWindows
}

// watchWin is a window as a step names it, and where it is on the screen now.
type watchWin struct {
	watchWindow
	left, top int
}

func watchWindowID(hwnd uintptr) string { return fmt.Sprintf("0x%x", hwnd) }

// watchWindowOf reads a top-level window: three cheap calls, nothing that
// asks the window itself.
func watchWindowOf(hwnd uintptr) (watchWin, bool) {
	if hwnd == 0 {
		return watchWin{}, false
	}
	var rc w32Rect
	if ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rc))); ok == 0 {
		return watchWin{}, false
	}
	pid := win32GetWindowPid(hwnd)
	return watchWin{
		watchWindow: watchWindow{ID: watchWindowID(hwnd), Pid: pid, App: processBaseName(pid), W: int(rc.Right - rc.Left), H: int(rc.Bottom - rc.Top)},
		left:        int(rc.Left), top: int(rc.Top),
	}, true
}

// The two words told once (notch_watch.go). Touched only by the recorder's
// worker goroutine, which is the one caller of the three functions below.
var notchWatchFlow watchFlow

// watchLooksAt says whether this program looks at a window now. Where it does
// not, the brain hears "gap" once and nothing else.
func watchLooksAt(win watchWin, hwnd uintptr) bool {
	if why := notchLookAway(notchAppKey(win.App), win32WindowTitle(hwnd)); why != "" {
		if notchWatchFlow.Away() {
			recorderEmit(notchWatchEvent, map[string]any{"kind": "gap", "ts": time.Now().UnixMilli()})
		}
		return false
	}
	notchWatchFlow.Looking()
	return true
}

func watchTellClick(site clickSite, mods string) {
	// A click on one of Jarvis's own windows (the notch, a panel) is not part of any job.
	if !site.Valid || site.HostHwnd == 0 || site.HostPid == ownPid {
		return
	}
	win, ok := watchWindowOf(site.HostHwnd)
	if !ok || !watchLooksAt(win, site.HostHwnd) {
		return
	}
	notchWatchFlow.Step()
	recorderEmit(notchWatchEvent, watchClickPayload(win.watchWindow, site.X-win.left, site.Y-win.top, mods, time.Now().UnixMilli()))
}

func watchTellKeys(front uintptr, keys string) {
	front = win32RootWindow(front)
	if front == 0 || ownWindow(front) {
		return
	}
	win, ok := watchWindowOf(front)
	if !ok || !watchLooksAt(win, front) {
		return
	}
	notchWatchFlow.Step()
	recorderEmit(notchWatchEvent, watchKeysPayload(win.watchWindow, keys, time.Now().UnixMilli()))
}

func watchTellTyped(front uintptr) {
	front = win32RootWindow(front)
	if front == 0 || ownWindow(front) {
		return
	}
	win, ok := watchWindowOf(front)
	if !ok || !watchLooksAt(win, front) {
		return
	}
	if notchWatchFlow.Typed() {
		recorderEmit(notchWatchEvent, map[string]any{"kind": "typed", "ts": time.Now().UnixMilli()})
	}
}

// ---------------------------------------------------------------------------
// The clipboard, read here and not through a shell: a job asks it once a round
// ---------------------------------------------------------------------------

func clipboardOpen() bool {
	for try := 0; try < 10; try++ {
		if ok, _, _ := procOpenClipboard.Call(0); ok != 0 {
			return true
		}
		// Another program has it open for a moment.
		time.Sleep(15 * time.Millisecond)
	}
	return false
}

func clipboardClear() bool {
	if !clipboardOpen() {
		return false
	}
	defer procCloseClipboard.Call()
	ok, _, _ := procEmptyClipboard.Call()
	return ok != 0
}

// clipboardText reads the text on the clipboard. False when there is none.
func clipboardText() (string, bool) {
	if has, _, _ := procClipboardHasFmt.Call(cfUnicodeText); has == 0 {
		return "", false
	}
	if !clipboardOpen() {
		return "", false
	}
	defer procCloseClipboard.Call()
	handle, _, _ := procGetClipboardData.Call(cfUnicodeText)
	if handle == 0 {
		return "", false
	}
	size, _, _ := procWatchGlobalSize.Call(handle)
	ptr, _, _ := procWatchGlobalLock.Call(handle)
	if ptr == 0 || size < 2 {
		return "", false
	}
	defer procWatchGlobalUnlock.Call(handle)
	units := unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), int(size/2)) //nolint:govet // a block Windows locked for us
	end := 0
	for end < len(units) && units[end] != 0 {
		end++
	}
	return string(utf16.Decode(units[:end])), true
}

// clipboardBlock copies bytes into a block the clipboard can take.
func clipboardBlock(data []byte) uintptr {
	handle, _, _ := procWatchGlobalAlloc.Call(gmemMoveable, uintptr(len(data)))
	if handle == 0 {
		return 0
	}
	ptr, _, _ := procWatchGlobalLock.Call(handle)
	if ptr == 0 {
		procWatchGlobalFree.Call(handle)
		return 0
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(data)), data) //nolint:govet // a block we allocated and locked
	procWatchGlobalUnlock.Call(handle)
	return handle
}

func clipboardSetText(text string) bool { return clipboardSet(text, "") }

// clipboardSet puts words on the clipboard, and beside them the same thing
// as a table or a list when there is one (pasteHTML), the way a spreadsheet
// does: a program takes the one it understands.
func clipboardSet(plain, html string) bool {
	units := utf16.Encode([]rune(plain + "\x00"))
	wide := make([]byte, len(units)*2)
	for i, unit := range units {
		wide[i*2], wide[i*2+1] = byte(unit), byte(unit>>8)
	}
	text := clipboardBlock(wide)
	if text == 0 {
		return false
	}
	var rich, richFormat uintptr
	if html != "" {
		name, _ := syscall.UTF16PtrFromString("HTML Format")
		richFormat, _, _ = procRegisterClipFmtW.Call(uintptr(unsafe.Pointer(name)))
		if richFormat != 0 {
			rich = clipboardBlock(append(clipHTML(html), 0))
		}
	}
	if !clipboardOpen() {
		procWatchGlobalFree.Call(text)
		if rich != 0 {
			procWatchGlobalFree.Call(rich)
		}
		return false
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	if set, _, _ := procSetClipboardData.Call(cfUnicodeText, text); set == 0 {
		procWatchGlobalFree.Call(text)
		if rich != 0 {
			procWatchGlobalFree.Call(rich)
		}
		return false
	}
	// The clipboard owns the first block now. The table is worth having, and not worth failing for.
	if rich != 0 {
		if set, _, _ := procSetClipboardData.Call(richFormat, rich); set == 0 {
			procWatchGlobalFree.Call(rich)
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// notch.act
// ---------------------------------------------------------------------------

// One thing at a time: two jobs do not share the pointer.
var notchActMu sync.Mutex

func notchActHwnd(id string) uintptr {
	var hwnd uint64
	if _, err := fmt.Sscanf(id, "0x%x", &hwnd); err != nil {
		return 0
	}
	return uintptr(hwnd)
}

// notchActWindowNow finds the window a step named, as it is now. It refuses a
// window that is gone, that another program now has the number of, that is
// put away, or that is one of Jarvis's own.
func notchActWindowNow(act notchAct) (uintptr, lookRect, *notchActError) {
	hwnd := notchActHwnd(act.Win.ID)
	if alive, _, _ := procIsWindow.Call(hwnd); hwnd == 0 || alive == 0 || win32GetWindowPid(hwnd) != act.Win.Pid {
		return 0, lookRect{}, &notchActError{"gone", "the window is not there any more"}
	}
	if ownWindow(hwnd) {
		return 0, lookRect{}, &notchActError{"own", "that is one of Jarvis's own windows"}
	}
	if small, _, _ := procIsIconic.Call(hwnd); small != 0 {
		return 0, lookRect{}, &notchActError{"gone", "the window is put away"}
	}
	win, ok := watchWindowOf(hwnd)
	if !ok {
		return 0, lookRect{}, &notchActError{"gone", "the window could not be read"}
	}
	return hwnd, lookRect{win.left, win.top, win.W, win.H}, nil
}

// notchActFront waits a moment for a window to be the one in front: a click
// that brings a window forward is answered a little before the window is
// there.
func notchActFront(hwnd uintptr) bool {
	for try := 0; try < 30; try++ {
		if win32RootWindow(win32GetForegroundWindow()) == hwnd {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// notchActPress sends Jarvis's pointer to a place, then presses there with
// the system's pointer and puts that back where it was. hwnd is the window
// the press is meant for, or 0 for whatever is at the place.
func notchActPress(act notchAct, at lookPoint, hwnd uintptr) *notchActError {
	under := win32RootWindow(win32WindowFromPoint(at.X, at.Y))
	switch {
	case under == 0:
		return &notchActError{"outside", "there is no window at that place"}
	case ownWindow(under):
		return &notchActError{"own", "one of Jarvis's own windows is at that place"}
	case hwnd != 0 && under != hwnd:
		return &notchActError{"covered", "another window is over that place"}
	case windowKeyReach(under) == keysBlocked:
		return &notchActError{"elevated", "that window runs as administrator"}
	}
	if hands := notchActHands(); hands != nil {
		// The pointer is seen to land before anything happens there.
		if took := hands.HandTo(act.Hand, at, false); took > 0 {
			time.Sleep(took + 40*time.Millisecond)
		}
	}
	var was w32Point
	had, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&was)))
	procSetCursorPos.Call(uintptr(at.X), uintptr(at.Y))
	procSleep.Call(30)
	// With the pointer there, the place is looked at once more: a sheet of
	// Jarvis's own can have come up under it meanwhile (pointerPress).
	if ownWindow(win32RootWindow(win32WindowFromPoint(at.X, at.Y))) {
		if had != 0 {
			procSetCursorPos.Call(uintptr(was.X), uintptr(was.Y))
		}
		return &notchActError{"own", "one of Jarvis's own windows came up at that place"}
	}
	var held []kbdInput
	var let []kbdInput
	for _, part := range splitKeys(act.Mods) {
		if vk, ok := modifierKeys[part]; ok {
			held = append(held, kbdInput{inputType: inputKeyboard, vk: vk})
			let = append([]kbdInput{{inputType: inputKeyboard, vk: vk, flags: keyeventfKeyUp}}, let...)
		}
	}
	_ = sendInputs(held)
	procMouseEvent.Call(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
	procMouseEvent.Call(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
	if act.Double {
		procSleep.Call(60)
		procMouseEvent.Call(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
		procMouseEvent.Call(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
	}
	_ = sendInputs(let)
	procSleep.Call(20)
	if had != 0 {
		procSetCursorPos.Call(uintptr(was.X), uintptr(was.Y))
	}
	return nil
}

func splitKeys(spec string) []string {
	var parts []string
	start := 0
	for i := 0; i <= len(spec); i++ {
		if i == len(spec) || spec[i] == ',' {
			if i > start {
				parts = append(parts, spec[start:i])
			}
			start = i + 1
		}
	}
	return parts
}

// notchActKeysIn presses keys in a window a step named: only when that window
// is the one in front, because the keys go to whatever is.
func notchActKeysIn(act notchAct, keys string) *notchActError {
	hwnd, _, refusal := notchActWindowNow(act)
	if refusal != nil {
		return refusal
	}
	if !notchActFront(hwnd) {
		return &notchActError{"front", "another window is in front"}
	}
	if windowKeyReach(hwnd) == keysBlocked {
		return &notchActError{"elevated", "that window runs as administrator"}
	}
	if err := pressKeysNative(keys); err != nil {
		return &notchActError{"failed", err.Error()}
	}
	return nil
}

func notchActWindows(act notchAct) (*RPCResult, error) {
	notchActMu.Lock()
	defer notchActMu.Unlock()
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
	switch act.Do {
	case "home":
		if hands := notchActHands(); hands != nil {
			hands.HandsHome()
		}
		return done(nil)

	case "front":
		hwnd := win32RootWindow(win32GetForegroundWindow())
		win, ok := watchWindowOf(hwnd)
		if !ok || ownWindow(hwnd) {
			return refuse(&notchActError{"gone", "no window is in front"})
		}
		return done(map[string]any{"win": win.payload(), "app": win.App})

	case "find":
		// The window a step named, as it is now; or, when its program was
		// started again since, that program's topmost window of the same size.
		same := func(win watchWin) bool {
			return absInt(win.W-act.Win.W) <= 2 && absInt(win.H-act.Win.H) <= 2
		}
		if hwnd, _, refusal := notchActWindowNow(act); refusal == nil {
			if win, ok := watchWindowOf(hwnd); ok && same(win) {
				return done(map[string]any{"win": win.payload(), "app": win.App})
			}
		}
		if act.App != "" {
			for _, top := range enumTopWindows() {
				if ownWindow(top.Hwnd) {
					continue
				}
				if small, _, _ := procIsIconic.Call(top.Hwnd); small != 0 {
					continue
				}
				if win, ok := watchWindowOf(top.Hwnd); ok && strings.EqualFold(win.App, act.App) && same(win) {
					return done(map[string]any{"win": win.payload(), "app": win.App})
				}
			}
		}
		return refuse(&notchActError{"gone", "no window of that program is there at that size"})

	case "hand":
		hands := notchActHands()
		if hands == nil {
			return refuse(&notchActError{"failed", "no pointer here"})
		}
		var at lookPoint
		if act.Beside && !act.Screen && act.Win.ID == "" {
			var p w32Point
			procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
			at = lookPoint{int(p.X) + 18, int(p.Y) + 14}
		} else {
			rect := lookRect{}
			if !act.Screen {
				var refusal *notchActError
				if _, rect, refusal = notchActWindowNow(act); refusal != nil {
					return refuse(refusal)
				}
			}
			var err error
			if at, err = notchActPlace(act, rect); err != nil {
				return refuse(err.(*notchActError))
			}
		}
		took := hands.HandTo(act.Hand, at, act.Beside)
		return done(map[string]any{"ms": took.Milliseconds()})

	case "count":
		// How many more there are, read from what the window says about
		// itself. Counts only: nothing that was read leaves this function.
		hands := notchActHands()
		if hands == nil {
			return done(map[string]any{"known": false, "left": 0})
		}
		hwnd, rect, refusal := notchActWindowNow(act)
		if refusal != nil {
			return refuse(refusal)
		}
		win, _ := watchWindowOf(hwnd)
		if notchLookAway(notchAppKey(win.App), win32WindowTitle(hwnd)) != "" {
			// Where this program looks away it does not count either.
			return done(map[string]any{"known": false, "left": 0})
		}
		left, known := watchCountLeft(func(k int) (lookThing, bool) {
			x, y := act.X+k*act.Dx, act.Y+k*act.Dy
			if x < 0 || y < 0 || x >= rect.W || y >= rect.H {
				return lookThing{}, false
			}
			return hands.ThingAt(lookPoint{rect.X + x, rect.Y + y}, false)
		}, act.Most)
		log.Printf("[notch] act: counted what is left: %d (could tell: %v)", left, known)
		return done(map[string]any{"known": known, "left": left})

	case "pitch":
		// How far apart the rows really are at a place, read from the screen
		// (watchPitch). A number leaves this function, and nothing else.
		hands := notchActHands()
		hwnd, rect, refusal := notchActWindowNow(act)
		if refusal != nil {
			return refuse(refusal)
		}
		unknown := map[string]any{"known": false, "dy": 0}
		win, _ := watchWindowOf(hwnd)
		if hands == nil || notchLookAway(notchAppKey(win.App), win32WindowTitle(hwnd)) != "" {
			return done(unknown)
		}
		at, err := notchActPlace(act, rect)
		if err != nil {
			return refuse(err.(*notchActError))
		}
		strip := watchStrip(rect, at, float64(act.Dy))
		shot, _ := hands.Snapshot(strip).(*lookShot)
		if strip.empty() || shot == nil || len(shot.pixels) < shot.w*shot.h*4 {
			return done(unknown)
		}
		pixels := make([]uint32, shot.w*shot.h)
		for i := range pixels {
			// The copy is blue, green, red, and a fourth byte that is not looked at.
			pixels[i] = uint32(shot.pixels[i*4+2])<<16 | uint32(shot.pixels[i*4+1])<<8 | uint32(shot.pixels[i*4])
		}
		exact, ok := watchPitch(watchProfile(pixels, shot.w, shot.h), float64(act.Dy))
		if !ok {
			log.Printf("[notch] act: no rows could be seen at that place")
			return done(unknown)
		}
		if act.Dy < 0 {
			exact = -exact
		}
		log.Printf("[notch] act: the rows there are %.2f pixels apart a step (the hand went %d)", exact, act.Dy)
		return done(map[string]any{"known": true, "dy": exact})

	case "click":
		var hwnd uintptr
		rect := lookRect{}
		if !act.Screen {
			var refusal *notchActError
			if hwnd, rect, refusal = notchActWindowNow(act); refusal != nil {
				return refuse(refusal)
			}
		}
		at, err := notchActPlace(act, rect)
		if err != nil {
			return refuse(err.(*notchActError))
		}
		if refusal := notchActPress(act, at, hwnd); refusal != nil {
			return refuse(refusal)
		}
		return done(nil)

	case "keys":
		if refusal := notchActKeysIn(act, act.Keys); refusal != nil {
			return refuse(refusal)
		}
		return done(nil)

	case "type":
		// Words typed where the keyboard is, in the window they were typed in when the job was shown.
		hwnd, _, refusal := notchActWindowNow(act)
		if refusal != nil {
			return refuse(refusal)
		}
		if !notchActFront(hwnd) {
			return refuse(&notchActError{"front", "another window is in front"})
		}
		if windowKeyReach(hwnd) == keysBlocked {
			return refuse(&notchActError{"elevated", "that window runs as administrator"})
		}
		if err := typeTextNative(act.Text, false); err != nil {
			return refuse(&notchActError{"failed", err.Error()})
		}
		return done(nil)

	case "copy":
		// What is selected is copied, and only its shape is told. The
		// clipboard is emptied first, so that "nothing was copied" is not
		// mistaken for the last thing that was.
		for i := 0; i < act.Right; i++ {
			if refusal := notchActKeysIn(act, "shift,right"); refusal != nil {
				return refuse(refusal)
			}
		}
		for i := 0; i < act.Down; i++ {
			if refusal := notchActKeysIn(act, "shift,down"); refusal != nil {
				return refuse(refusal)
			}
		}
		if act.Right+act.Down > 0 {
			time.Sleep(60 * time.Millisecond)
		}
		if !clipboardClear() {
			return refuse(&notchActError{"failed", "the clipboard could not be emptied"})
		}
		keys := act.Keys
		if keys == "" {
			keys = "ctrl,c"
		}
		if refusal := notchActKeysIn(act, keys); refusal != nil {
			return refuse(refusal)
		}
		text := ""
		for try := 0; try < 36; try++ {
			time.Sleep(25 * time.Millisecond)
			if got, ok := clipboardText(); ok {
				text = got
				break
			}
		}
		return done(clipShapeOf(text).payload())

	case "paste":
		plain, html, shape := pasteFlavours(act)
		if act.Front {
			// Where the person already is: at the caret of the window in
			// front, with no click first.
			front := win32RootWindow(win32GetForegroundWindow())
			switch {
			case front == 0:
				return refuse(&notchActError{"gone", "no window is in front"})
			case ownWindow(front):
				return refuse(&notchActError{"own", "one of Jarvis's own windows is in front"})
			case windowKeyReach(front) == keysBlocked:
				return refuse(&notchActError{"elevated", "that window runs as administrator"})
			}
			if !clipboardSet(plain, html) {
				return refuse(&notchActError{"failed", "the clipboard could not be written"})
			}
			if err := pressKeysNative("ctrl,v"); err != nil {
				return refuse(&notchActError{"failed", err.Error()})
			}
			time.Sleep(120 * time.Millisecond)
			win, _ := watchWindowOf(front)
			return done(map[string]any{"win": win.payload(), "app": win.App, "shape": clipShapeOf(shape).payload()})
		}
		var hwnd uintptr
		rect := lookRect{}
		if !act.Screen {
			var refusal *notchActError
			if hwnd, rect, refusal = notchActWindowNow(act); refusal != nil {
				return refuse(refusal)
			}
		}
		at, err := notchActPlace(act, rect)
		if err != nil {
			return refuse(err.(*notchActError))
		}
		before, had := clipboardText()
		if !clipboardSet(plain, html) {
			return refuse(&notchActError{"failed", "the clipboard could not be written"})
		}
		restore := func() {
			if had {
				clipboardSetText(before)
			} else {
				clipboardClear()
			}
		}
		if refusal := notchActPress(act, at, hwnd); refusal != nil {
			restore()
			return refuse(refusal)
		}
		target := win32RootWindow(win32WindowFromPoint(at.X, at.Y))
		if !notchActFront(target) || windowKeyReach(target) == keysBlocked {
			restore()
			return refuse(&notchActError{"front", "the window at that place did not come to the front"})
		}
		time.Sleep(80 * time.Millisecond)
		if err := pressKeysNative("ctrl,v"); err != nil {
			restore()
			return refuse(&notchActError{"failed", err.Error()})
		}
		// What was put stays on the clipboard. A program reads the clipboard
		// when it gets round to the paste, and a slow one that got round to
		// it after the person's own text was put back would paste that
		// instead: the wrong thing, in the right place. A changed clipboard
		// is the smaller harm.
		time.Sleep(120 * time.Millisecond)
		win, _ := watchWindowOf(target)
		return done(map[string]any{
			"win": win.payload(), "app": win.App,
			"pt":    map[string]any{"x": at.X - win.left, "y": at.Y - win.top},
			"shape": clipShapeOf(shape).payload(),
		})
	}
	return nil, fmt.Errorf("notch.act: do must be click, keys, type, copy, paste, hand, home, front, find, count or pitch")
}
