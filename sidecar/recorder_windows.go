//go:build windows

package main

// recorder_windows.go: learn-by-watching input capture.
//
// Installs global low-level mouse + keyboard hooks (WH_MOUSE_LL / WH_KEYBOARD_LL)
// on a dedicated OS thread. It never swallows input (returns via CallNextHookEx
// always); it only observes. Hook procs do nothing but enqueue; a worker
// goroutine does the UIA reads through the shared COM thread and emits one
// ui_interaction event per meaningful action:
//
//   first printable key   the keyboard-focused element is captured as the
//                         field being typed into (typing_started)
//   Enter / Tab           the field's committed value is read from its Value
//                         pattern and emitted as a set_value (commit)
//   left button down      same flush, for a field committed by clicking away
//   left button up        the element under the cursor is emitted as a click
//
// Keystroke content is never transmitted: the field's final value is read
// from UIA at flush time, and a password field (UIA IsPassword) yields no
// value at all, only secure: true. Brain-side redaction covers the rest.
//
// A failed hook install is returned as an error from the thread that made
// the call (GetLastError is thread-local, so it cannot be read afterwards
// from the caller's goroutine); recorder.go turns that into an RPC error.

import (
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	ole "github.com/go-ole/go-ole"
)

const (
	whKeyboardLL     = 13
	wmKeyDown        = 0x0100
	wmSysKeyDown     = 0x0104
	wmLButtonDownRec = 0x0201
	// wmLButtonUp (0x0202) is declared in sub_pebble_overlay_windows.go.

	vkReturnRec = 0x0D
	vkTabRec    = 0x09

	wmKeyUpRec    = 0x0101
	wmSysKeyUpRec = 0x0105
)

// kbdllHookStruct: WH_KEYBOARD_LL callback payload.
type kbdllHookStruct struct {
	VkCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

// clickSite is what the hook records about where a click went, at the
// moment it went there. It exists because attribution used to be resolved
// 60ms or more later, against whatever the foreground window had become by
// then -- so a click made during an app switch (which a demonstration does
// constantly) was attributed to a control the person never touched (#499).
//
// HostHwnd is the window that received the click: WindowFromPoint resolved
// through GA_ROOT. It is the answer #493 was reaching for when it used the
// foreground window, and it is right in the cases where the two differ (a
// taskbar button, a notification, any click on a window that is not the
// foreground one).
type clickSite struct {
	// X, Y is where the site was sampled, which is the press point unless
	// the pointer moved too far before the release.
	X, Y int
	// The foreground window when the button went down, for the log only.
	FgHwnd uintptr
	FgPid  uint32
	// The top-level window under the pointer then, and its process.
	HostHwnd uintptr
	HostPid  uint32
	// The top-level window holding the mouse capture then (0 for none), and
	// whether a menu was open. A window with capture gets the click
	// wherever the pointer is, so when these disagree with HostHwnd the
	// window under the pointer received nothing.
	CaptureHwnd uintptr
	MenuUp      bool
	// Valid distinguishes a sampled site from the zero value; an unsampled
	// click is dropped rather than attributed (clickAttribution fails
	// closed on a zero HostHwnd anyway, this just makes it legible).
	Valid bool
}

type recorderEvent struct {
	kind string    // typing_started | commit | flush | click | keys | typed | record_end
	site clickSite // click only; carries the point as well as the windows
	// click: what was held down with it ("shift"). keys: the named key or
	// shortcut ("ctrl,c"), never a key that types.
	keys string
	// keys: the window that was in front when the key went down.
	front uintptr
	// What the hooks were in for when this happened: a recording ("Watch
	// me"), or the notch watching by itself. A recording comes first.
	rec, watch bool
}

type recorderHook struct {
	stopCh   chan struct{}
	tid      uint32
	typed    atomic.Bool // printable keys arrived since the last flush
	stopOnce sync.Once

	// Why the hooks are in. Either or both. The callbacks read them on every
	// event, so that a recording that ends while the notch still watches does
	// not go on being recorded.
	recording atomic.Bool
	watching  atomic.Bool
	// The notch, watching by itself, was told "typed" and has seen no step
	// since: it is not told again for every letter.
	watchTyped atomic.Bool
	// How the worker is reached from outside the callbacks.
	events chan recorderEvent
	// The key of the last shortcut that went down and has not come up. A
	// shortcut held a moment too long repeats itself, and Ctrl + C three
	// times in one round and once in the next would not look like the same
	// job. Touched only by the keyboard callback.
	heldChord uint32

	// downSite is the site sampled at the last left-button press, handed to
	// the click event emitted at the release. It is not synchronised, and
	// the reason it is safe is narrower than "one thread": Windows delivers
	// every WH_MOUSE_LL callback on the thread that installed the hook, and
	// nothing outside that thread ever reads or writes this field (the
	// value is copied into the event). A callback CAN nest -- a thread
	// waiting inside a cross-thread SendMessage still dispatches sent
	// messages -- so a slow sample could see a nested press overwrite this
	// one. The damage is bounded to one click: the release then finds a
	// site whose point no longer matches and re-samples. slowSamples below
	// is what makes that visible if it ever happens.
	downSite clickSite

	// Counters for samples that took long enough to be worth knowing about,
	// written by the hook thread and drained by the worker. A low-level
	// hook that overruns LowLevelHooksTimeout is skipped, and a hook that
	// keeps overrunning is removed by Windows without a word to anyone, so
	// the only symptom is a recording that quietly stops capturing. These
	// turn that into a log line.
	slowSamples atomic.Int64
	slowestNs   atomic.Int64
}

// hookSampleBudget is how long a click-time sample may take before it is
// worth reporting. Windows' own LowLevelHooksTimeout defaults to 300ms and
// covers the whole callback; this is well under it so the log complains
// before Windows acts.
const hookSampleBudget = 40 * time.Millisecond

// noteSlowSample records an over-budget sample. Called from the hook, so it
// does no I/O: the worker prints it.
func (h *recorderHook) noteSlowSample(d time.Duration) {
	h.slowSamples.Add(1)
	// CompareAndSwap rather than load-then-store: the worker's Swap(0) can
	// land in between, and a plain store would then resurrect a previous
	// batch's worst time into the next report.
	for ns := int64(d); ; {
		worst := h.slowestNs.Load()
		if ns <= worst || h.slowestNs.CompareAndSwap(worst, ns) {
			return
		}
	}
}

// reportSlowSamples prints and clears whatever the hook recorded. Called
// from the worker goroutine, never from the callback.
func (h *recorderHook) reportSlowSamples() {
	n := h.slowSamples.Swap(0)
	if n == 0 {
		return
	}
	worst := time.Duration(h.slowestNs.Swap(0))
	log.Printf("[recorder] %d click-time sample(s) took over %s (worst %s): a low-level hook this slow is skipped by Windows, and eventually removed, which would stop the recording capturing anything",
		n, hookSampleBudget, worst)
}

// sampleClickSite records where a click went, from inside the hook callback.
//
// Everything here is a cheap kernel-side read: no allocation beyond the
// returned struct, no lock, no UIA, no COM, no wait on another thread. That
// budget is not a preference -- a low-level hook that overruns
// LowLevelHooksTimeout is silently removed by Windows, and the recording
// would then just stop working with no error anywhere.
//
// WindowFromPoint is the one call here that is not purely a table lookup: it
// hit-tests, so a window that declares itself transparent to the mouse
// (WS_EX_TRANSPARENT, a region set by SetWindowRgn, or HTTRANSPARENT from
// its WndProc) is skipped and the window that really receives the click is
// returned. That is exactly what this needs, and it is the same test Windows
// performs to deliver the click -- but not on the same thread and not under
// the same deadline. Honouring HTTRANSPARENT means sending WM_NCHITTEST to
// the owning thread, and a thread that is busy (one of our own WebView2
// windows mid-navigation, say) makes that wait. That is why every sample is
// timed and an over-budget one is reported: this is the call that would do
// it, and Windows would otherwise remove the hook in silence.
func (h *recorderHook) sampleClickSite(x, y int) clickSite {
	started := time.Now()
	site := clickSite{X: x, Y: y, Valid: true}
	site.FgHwnd = win32GetForegroundWindow()
	site.FgPid = win32GetWindowPid(site.FgHwnd)
	site.HostHwnd = win32RootWindow(win32WindowFromPoint(x, y))
	site.HostPid = win32GetWindowPid(site.HostHwnd)
	if gui, ok := win32ForegroundGUIInfo(); ok {
		site.CaptureHwnd = win32RootWindow(gui.HwndCapture)
		site.MenuUp = gui.Flags&(guiInMenuMode|guiPopupMenuMode|guiSystemMenuMode) != 0
	}
	if d := time.Since(started); d > hookSampleBudget {
		h.noteSlowSample(d)
	}
	return site
}

var (
	hookMu             sync.Mutex
	activeRecorderHook *recorderHook

	// ownPid identifies the sidecar's own windows, which are never recorded.
	ownPid = uint32(os.Getpid())

	// The field being typed into, owned by the COM thread: only closures run
	// through comThread.call touch these.
	recPendingElem *ole.IDispatch
	recPendingInfo *recordedElement
	// The window that was in front when the typing began: what was typed is
	// told with it, so that the step has a place to be done again.
	recPendingFront uintptr

	// What the hooks are wanted for, under hookMu: a recording, the notch's
	// own watching, or both. They are in while either is wanted.
	hookWantRecord bool
	hookWantWatch  bool
)

func init() {
	inputHookStart = startInputRecording
	inputHookStop = stopInputRecording
	notchWatchSet = setNotchWatching
}

// Flags Windows puts on an event that a program made and no hand did.
const (
	llmhfInjected = 0x01
	llkhfInjected = 0x10
)

// hookMods reads which modifier keys are down, from inside a hook callback.
// Four table lookups: nothing that waits.
func hookMods() watchMods {
	down := func(vk uintptr) bool {
		state, _, _ := procGetAsyncKeyState.Call(vk)
		return state&asyncKeyHeldHi != 0
	}
	m := watchMods{Ctrl: down(0x11), Alt: down(0x12), Shift: down(0x10), Win: down(0x5B) || down(0x5C)}
	// AltGr is the right Alt, which Windows reports with the left Ctrl.
	m.AltGr = m.Ctrl && down(0xA5)
	return m
}

// warmHookProcs resolves every user32 entry point the hook callbacks use,
// before the hooks are installed.
//
// syscall.LazyProc.Call resolves its procedure on first use: it takes a
// mutex and may LoadLibrary, and it PANICS if the entry point is missing.
// Neither belongs inside a low-level hook callback -- the first would be a
// stall on the path Windows times out and silently unhooks, and the second
// would take the process down from a Windows-owned thread. Doing it here
// turns a missing entry point into a refused recorder_start with a name in
// it.
func warmHookProcs() error {
	for _, p := range []*syscall.LazyProc{
		procCallNextHookEx,
		procGetForegroundWindow,
		procGetWindowThreadProcId,
		procGetAncestor,
		procWindowFromPoint,
		procGetGUIThreadInfo,
		procGetAsyncKeyState,
	} {
		if err := p.Find(); err != nil {
			return fmt.Errorf("resolving %s: %w", p.Name, err)
		}
	}
	return nil
}

// startInputRecording puts the hooks in for a recording. Called under
// recorderOpMu from handleRecorderStart; hookMu additionally guards
// activeRecorderHook so a stop that races an in-flight install cannot leave
// hooks behind.
func startInputRecording() error {
	hookMu.Lock()
	defer hookMu.Unlock()
	if err := installInputHooks(); err != nil {
		return err
	}
	hookWantRecord = true
	activeRecorderHook.recording.Store(true)
	return nil
}

// setNotchWatching puts the hooks in, or lets them go, for the notch watching
// by itself. What it sees is told as shapes only (notch_watch.go).
func setNotchWatching(on bool) error {
	hookMu.Lock()
	defer hookMu.Unlock()
	if !on {
		hookWantWatch = false
		if h := activeRecorderHook; h != nil {
			h.watching.Store(false)
		}
		removeInputHooksIfIdle()
		return nil
	}
	if err := installInputHooks(); err != nil {
		return err
	}
	hookWantWatch = true
	activeRecorderHook.watching.Store(true)
	return nil
}

// installInputHooks installs the hooks if they are not in. With hookMu held.
func installInputHooks() error {
	if activeRecorderHook != nil {
		return nil
	}

	if err := warmHookProcs(); err != nil {
		return err
	}

	evCh := make(chan recorderEvent, 64)
	h := &recorderHook{stopCh: make(chan struct{}), events: evCh}

	go recorderWorker(h, evCh)

	enqueue := func(e recorderEvent) {
		select {
		case evCh <- e:
		default:
			// Never block Windows inside a hook; a dropped event is a
			// missed step the person can re-record, a stall is not.
		}
	}

	mouseProc := syscall.NewCallback(func(nCode int32, wParam uintptr, lParam uintptr) uintptr {
		if nCode >= 0 && (wParam == wmLButtonDownRec || wParam == wmLButtonUp) {
			// One conversion for both buttons: lParam is a real
			// MSLLHOOKSTRUCT address Windows owns for the duration of the
			// callback, which is the documented vet exception here.
			ms := (*msllHookStruct)(unsafe.Pointer(lParam))
			x, y := int(ms.Pt.X), int(ms.Pt.Y)
			rec, watch := h.recording.Load(), h.watching.Load()
			// A click a program made is not something the person did: above
			// all Jarvis's own, when it does a job again where it can be
			// seen. Recorded, it would be taken for the person's next round.
			if ms.Flags&llmhfInjected != 0 {
				rec, watch = false, false
			}
			switch {
			case !rec && !watch:
			case wParam == wmLButtonDownRec:
				// Sample the target at the PRESS, not at the release.
				// Activation and menu dismissal both happen on the press,
				// so a site read at the release can already name the window
				// that replaced the one clicked -- the window revealed
				// behind a closing menu, or the app that just came up.
				h.downSite = h.sampleClickSite(x, y)
				if rec && h.typed.Swap(false) {
					enqueue(recorderEvent{kind: "flush"})
				}
			default:
				site := h.downSite
				h.downSite = clickSite{}
				if !pressSiteStillApplies(site.X, site.Y, site.Valid, x, y) {
					// A drag, or a release whose press we never saw
					// (recording armed mid-click). Sample here instead, so
					// the window recorded and the point everything downstream
					// resolves at describe the same place.
					site = h.sampleClickSite(x, y)
				}
				h.watchTyped.Store(false)
				enqueue(recorderEvent{kind: "click", site: site, keys: watchClickMods(hookMods()), rec: rec, watch: watch})
			}
		}
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	})

	keyboardProc := syscall.NewCallback(func(nCode int32, wParam uintptr, lParam uintptr) uintptr {
		if nCode >= 0 && (wParam == wmKeyUpRec || wParam == wmSysKeyUpRec) {
			if ks := (*kbdllHookStruct)(unsafe.Pointer(lParam)); ks.VkCode == h.heldChord {
				h.heldChord = 0
			}
		}
		if nCode >= 0 && (wParam == wmKeyDown || wParam == wmSysKeyDown) {
			ks := (*kbdllHookStruct)(unsafe.Pointer(lParam))
			rec, watch := h.recording.Load(), h.watching.Load()
			// Keys a program pressed are not the person's: Jarvis's own, above all.
			if ks.Flags&llkhfInjected != 0 {
				rec, watch = false, false
			}
			if rec || watch {
				// Which key it is decides only what kind of thing happened: a
				// named key or a shortcut is a step and is named; a key that
				// types is "typing", and which key it was goes no further than
				// this line (notch_watch.go).
				mods := hookMods()
				kind, spec := watchKey(ks.VkCode, mods)
				if kind == watchKeyStep && (mods.Ctrl || mods.Alt || mods.Win) {
					if ks.VkCode == h.heldChord {
						// The same shortcut, still held: it was told when it went down.
						kind = watchKeyNone
					}
					h.heldChord = ks.VkCode
				}
				switch kind {
				case watchKeyStep:
					if rec && (ks.VkCode == vkReturnRec || ks.VkCode == vkTabRec) && h.typed.Swap(false) {
						enqueue(recorderEvent{kind: "commit"})
					}
					h.watchTyped.Store(false)
					enqueue(recorderEvent{kind: "keys", keys: spec, front: win32GetForegroundWindow(), rec: rec, watch: watch})
				case watchKeyTyped:
					// Mark that the person is typing into the focused field. The
					// character itself is not recorded; the committed value is
					// read from UIA at flush time.
					if rec && isPrintableVk(ks.VkCode) && !h.typed.Swap(true) {
						enqueue(recorderEvent{kind: "typing_started", front: win32GetForegroundWindow()})
					}
					if watch && !rec && !h.watchTyped.Swap(true) {
						enqueue(recorderEvent{kind: "typed", front: win32GetForegroundWindow(), watch: true})
					}
				}
			}
		}
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	})

	installErr := make(chan error, 1)
	tidCh := make(chan uint32, 1)

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		tid, _, _ := procGetCurrentThread.Call()
		tidCh <- uint32(tid)

		hMod, _, _ := procGetModuleHandleW.Call(0)
		hMouse, _, eMouse := procSetWindowsHookExW.Call(uintptr(whMouseLL), mouseProc, hMod, 0)
		if hMouse == 0 {
			installErr <- fmt.Errorf("SetWindowsHookEx(WH_MOUSE_LL): %v", eMouse)
			return
		}
		hKey, _, eKey := procSetWindowsHookExW.Call(uintptr(whKeyboardLL), keyboardProc, hMod, 0)
		if hKey == 0 {
			procUnhookWindowsHookEx.Call(hMouse)
			installErr <- fmt.Errorf("SetWindowsHookEx(WH_KEYBOARD_LL): %v", eKey)
			return
		}
		installErr <- nil

		for {
			var msg w32Msg
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if r == 0 || r == ^uintptr(0) {
				break
			}
		}
		procUnhookWindowsHookEx.Call(hMouse)
		procUnhookWindowsHookEx.Call(hKey)
	}()

	h.tid = <-tidCh
	if err := <-installErr; err != nil {
		close(h.stopCh)
		return err
	}
	activeRecorderHook = h
	return nil
}

func stopInputRecording() {
	hookMu.Lock()
	defer hookMu.Unlock()
	hookWantRecord = false
	if h := activeRecorderHook; h != nil {
		h.recording.Store(false)
		h.typed.Store(false)
		// The field that was being typed into is let go, as it is when the
		// hooks come out: the hooks may stay in now, for the notch.
		select {
		case h.events <- recorderEvent{kind: "record_end"}:
		default:
		}
	}
	removeInputHooksIfIdle()
}

// removeInputHooksIfIdle takes the hooks out when nothing wants them. With
// hookMu held.
func removeInputHooksIfIdle() {
	h := activeRecorderHook
	if h == nil || hookWantRecord || hookWantWatch {
		return
	}
	activeRecorderHook = nil
	h.stopOnce.Do(func() {
		close(h.stopCh)
		procPostThreadMsg.Call(uintptr(h.tid), wmQuit, 0, 0)
	})
}

// recorderWorker drains the hook events in order so a flush always precedes
// the click that caused it.
func recorderWorker(h *recorderHook, evCh <-chan recorderEvent) {
	for {
		select {
		case <-h.stopCh:
			// Also here, not only per event: if the samples got slow
			// enough that Windows started skipping the hook, the events
			// that would have carried this report are the ones that never
			// arrived.
			h.reportSlowSamples()
			_, _ = comThread.call(func(state *uiaState) (any, error) {
				releasePendingField()
				return nil, nil
			})
			return
		case e := <-evCh:
			// Anything the hook could not afford to say for itself.
			h.reportSlowSamples()
			switch e.kind {
			case "typing_started":
				captureTypingField(e.front)
			case "commit", "flush":
				flushTypingField()
			case "click":
				if e.rec {
					captureClick(e.site, e.keys)
				} else if e.watch {
					watchTellClick(e.site, e.keys)
				}
			case "keys":
				if e.rec {
					recordKeys(e.front, e.keys)
				} else if e.watch {
					watchTellKeys(e.front, e.keys)
				}
			case "typed":
				watchTellTyped(e.front)
			case "record_end":
				_, _ = comThread.call(func(state *uiaState) (any, error) {
					releasePendingField()
					return nil, nil
				})
			}
		}
	}
}

// isOwnWindow reports whether the element lives in one of the sidecar's own
// windows, and is never recorded. The decision table (including the
// fail-closed case where the hosting window is unknown) is ownWindowVerdict
// in recorder.go, which is unit-tested on every platform.
//
// This is the typing path's test, where the focused element is all there is
// to go on. A click has more: the window that received it was recorded when
// it happened, so ownership there is decided by clickAttribution from that
// window instead (see uiaClickedElement).
func isOwnWindow(rec *recordedElement) bool {
	return ownWindowVerdict(rec.Pid, rec.HostPid, ownPid, rec.HostKnown)
}

func releasePendingField() {
	if recPendingElem != nil {
		recPendingElem.Release()
	}
	recPendingElem = nil
	recPendingInfo = nil
	recPendingFront = 0
}

// captureTypingField remembers the keyboard-focused element at the first
// keystroke, so its committed value can be read later even if focus has
// moved on by then (Tab, click-away).
func captureTypingField(front uintptr) {
	_, err := comThread.call(func(state *uiaState) (any, error) {
		releasePendingField()
		rec, err := uiaRecordedElement(state, "focus", 0, 0, clickSite{})
		if err != nil {
			return nil, err
		}
		if isOwnWindow(rec) {
			// Typing into Jarvis's own window (the chat panel, the connect
			// window) is never part of a demonstration.
			return nil, fmt.Errorf("%w: %s", errOwnWindow, ownWindowReason(rec.Pid, rec.HostPid, ownPid, rec.HostKnown))
		}
		elem, err := uiaGetFocusedElement(state.automation)
		if err != nil {
			return nil, err
		}
		recPendingElem = elem
		recPendingInfo = rec
		recPendingFront = win32RootWindow(front)
		return nil, nil
	})
	if errors.Is(err, errOwnWindow) {
		// Not a fault, just not a step. Logged anyway, with which of the two
		// reasons it was: "the recorder ignored my typing" is diagnosed from
		// this log, and a silent drop is what makes that hard.
		log.Printf("[recorder] ignored typing: %v", err)
		return
	}
	if err != nil {
		log.Printf("[recorder] capture failed (typing): %v", err)
	}
}

// flushTypingField emits the pending field as a set_value carrying its
// current Value-pattern text (none for a secure field).
func flushTypingField() {
	var front uintptr
	val, err := comThread.call(func(state *uiaState) (any, error) {
		if recPendingElem == nil || recPendingInfo == nil {
			return nil, nil
		}
		rec := *recPendingInfo
		if !rec.Secure {
			if v, verr := patternGetValue(recPendingElem); verr == nil {
				rec.Value = v
				rec.HasVal = true
			}
		}
		front = recPendingFront
		releasePendingField()
		return &rec, nil
	})
	if err != nil {
		log.Printf("[recorder] capture failed (flush): %v", err)
		return
	}
	if val == nil {
		return
	}
	rec, ok := val.(*recordedElement)
	if !ok || rec == nil {
		return
	}
	payload := interactionPayload(rec)
	payload["action"] = "set_value"
	if rec.HasVal {
		payload["value"] = rec.Value
	}
	// Which window it was typed in: a step that is done again by place
	// needs one (notch_watch.go). Never one of Jarvis's own.
	if front != 0 && !ownWindow(front) {
		if win, ok := watchWindowOf(front); ok {
			payload["win"] = win.payload()
		}
	}
	// The value itself is never logged.
	log.Printf("[recorder] set_value: %s %q (secure=%v, app=%s)", rec.Role, rec.Name, rec.Secure, rec.App)
	emitInteraction(payload)
}

// captureClick hit-tests the click point after a short settle so the
// element reflects the just-finished action. site is what the hook recorded
// about where the click went when it went there; the settle is why that
// cannot be worked out here instead.
func captureClick(site clickSite, mods string) {
	// The point comes from the site, not from the release, so the window
	// recorded and the point resolved against are the same place. They
	// differ by at most clickSlopPx, which is enough to land on the
	// neighbouring control at a window edge.
	x, y := site.X, site.Y
	time.Sleep(60 * time.Millisecond)
	val, err := comThread.call(func(state *uiaState) (any, error) {
		return uiaRecordedElement(state, "click", x, y, site)
	})
	if errors.Is(err, errOwnWindow) {
		// A click on Jarvis's own window (saying "done" in the chat) is not
		// part of the demonstration. Dropped inside uiaClickedElement, before
		// the re-attribution could turn it into a step in the app behind
		// the panel.
		log.Printf("[recorder] ignored click at %d,%d: %v", x, y, err)
		return
	}
	if errors.Is(err, errClickUnattributable) {
		// A step the person probably expected to see. Logged with the full
		// reason (which window took the click, what became of it, whether
		// the foreground moved) because a dropped click is invisible on the
		// approval card and this line is the only trace of it.
		log.Printf("[recorder] dropped click at %d,%d (site: hwnd %#x pid %d, fg hwnd %#x pid %d): %v",
			x, y, site.HostHwnd, site.HostPid, site.FgHwnd, site.FgPid, err)
		return
	}
	if err != nil {
		log.Printf("[recorder] capture failed (click at %d,%d): %v", x, y, err)
		return
	}
	rec, ok := val.(*recordedElement)
	if !ok || rec == nil {
		return
	}
	if rec.Pid == ownPid || (rec.HostKnown && rec.HostPid == ownPid) {
		// Belt and braces: the element the resolution settled on is ours.
		//
		// Deliberately NOT isOwnWindow: that fails closed on an element
		// whose hosting window UIA would not name, which is right for
		// typing (where nothing else identifies a Jarvis panel) and wrong
		// here. Whether this click was ours has already been decided from
		// the window that received it, which is known, alive and not ours
		// by the time we get here -- so an unreadable host is no longer a
		// reason to suspect a panel, and treating it as one would drop a
		// real step and log the wrong cause for it.
		log.Printf("[recorder] ignored click at %d,%d on Jarvis's own window (%s %q; site: hwnd %#x pid %d)",
			x, y, rec.Role, rec.Name, site.HostHwnd, site.HostPid)
		return
	}
	payload := interactionPayload(rec)
	payload["action"] = "click"
	// Where in its window the click landed, and which window that was: what a
	// job done several times over is told apart by (notch_watch.go).
	if win, ok := watchWindowOf(site.HostHwnd); ok {
		payload["win"] = win.payload()
		payload["pt"] = map[string]any{"x": site.X - win.left, "y": site.Y - win.top}
	}
	if mods != "" {
		payload["mods"] = mods
	}
	log.Printf("[recorder] click: %s %q (app=%s)", rec.Role, rec.Name, rec.App)
	emitInteraction(payload)
}

// recordKeys tells a named key or a shortcut pressed during a recording: a
// step of its own, pressed again as it was when the job is done again.
func recordKeys(front uintptr, keys string) {
	front = win32RootWindow(front)
	if front == 0 || ownWindow(front) {
		// Pressed in one of Jarvis's own windows: not part of what is shown.
		return
	}
	win, _ := watchWindowOf(front)
	payload := map[string]any{
		"surface": "desktop", "ts": time.Now().UnixMilli(), "secure": false,
		"action": "press_keys", "value": keys,
	}
	if win.App != "" {
		payload["app"] = win.App
		payload["win"] = win.payload()
	}
	if title := win32WindowTitle(front); title != "" {
		payload["title"] = title
	}
	log.Printf("[recorder] press_keys: %s (app=%s)", keys, win.App)
	emitInteraction(payload)
}

func interactionPayload(rec *recordedElement) map[string]any {
	payload := map[string]any{
		"surface": "desktop",
		"ts":      time.Now().UnixMilli(),
		"secure":  rec.Secure,
		"ref": map[string]any{
			"role":     rec.Role,
			"name":     rec.Name,
			"stableId": rec.AutoID,
			"path":     rec.Path,
			"ordinal":  rec.Ordinal,
			"sig":      rec.Sig,
		},
	}
	if rec.App != "" {
		payload["app"] = rec.App
	}
	if rec.Title != "" {
		payload["title"] = rec.Title
	}
	return payload
}

// isPrintableVk reports whether a virtual-key code is a text-producing key
// (letters, digits, common punctuation); used only to set the typing flag.
func isPrintableVk(vk uint32) bool {
	if vk >= 0x30 && vk <= 0x5A { // 0-9, A-Z
		return true
	}
	if vk >= 0x60 && vk <= 0x69 { // numpad 0-9
		return true
	}
	if vk >= 0xBA && vk <= 0xE2 { // OEM punctuation range
		return true
	}
	return vk == 0x20 // space
}
