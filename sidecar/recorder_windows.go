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
	"fmt"
	"log"
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
)

// kbdllHookStruct: WH_KEYBOARD_LL callback payload.
type kbdllHookStruct struct {
	VkCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

type recorderEvent struct {
	kind string // typing_started | commit | flush | click
	x, y int
}

type recorderHook struct {
	stopCh   chan struct{}
	tid      uint32
	typed    atomic.Bool // printable keys arrived since the last flush
	stopOnce sync.Once
}

var (
	hookMu             sync.Mutex
	activeRecorderHook *recorderHook

	// The field being typed into, owned by the COM thread: only closures run
	// through comThread.call touch these.
	recPendingElem *ole.IDispatch
	recPendingInfo *recordedElement
)

func init() {
	inputHookStart = startInputRecording
	inputHookStop = stopInputRecording
}

// startInputRecording installs the hooks. Called under recorderOpMu from
// handleRecorderStart; hookMu additionally guards activeRecorderHook so a
// stop that races an in-flight install cannot leave hooks behind.
func startInputRecording() error {
	hookMu.Lock()
	defer hookMu.Unlock()
	if activeRecorderHook != nil {
		return nil
	}

	h := &recorderHook{stopCh: make(chan struct{})}
	evCh := make(chan recorderEvent, 64)

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
		if nCode >= 0 {
			switch wParam {
			case wmLButtonDownRec:
				if h.typed.Swap(false) {
					enqueue(recorderEvent{kind: "flush"})
				}
			case wmLButtonUp:
				ms := (*msllHookStruct)(unsafe.Pointer(lParam))
				enqueue(recorderEvent{kind: "click", x: int(ms.Pt.X), y: int(ms.Pt.Y)})
			}
		}
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	})

	keyboardProc := syscall.NewCallback(func(nCode int32, wParam uintptr, lParam uintptr) uintptr {
		if nCode >= 0 && (wParam == wmKeyDown || wParam == wmSysKeyDown) {
			ks := (*kbdllHookStruct)(unsafe.Pointer(lParam))
			switch ks.VkCode {
			case vkReturnRec, vkTabRec:
				if h.typed.Swap(false) {
					enqueue(recorderEvent{kind: "commit"})
				}
			default:
				// Mark that the person is typing into the focused field. The
				// character itself is not recorded; the committed value is
				// read from UIA at flush time.
				if isPrintableVk(ks.VkCode) && !h.typed.Swap(true) {
					enqueue(recorderEvent{kind: "typing_started"})
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
	h := activeRecorderHook
	activeRecorderHook = nil
	hookMu.Unlock()
	if h == nil {
		return
	}
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
			_, _ = comThread.call(func(state *uiaState) (any, error) {
				releasePendingField()
				return nil, nil
			})
			return
		case e := <-evCh:
			switch e.kind {
			case "typing_started":
				captureTypingField()
			case "commit", "flush":
				flushTypingField()
			case "click":
				captureClick(e.x, e.y)
			}
		}
	}
}

func releasePendingField() {
	if recPendingElem != nil {
		recPendingElem.Release()
	}
	recPendingElem = nil
	recPendingInfo = nil
}

// captureTypingField remembers the keyboard-focused element at the first
// keystroke, so its committed value can be read later even if focus has
// moved on by then (Tab, click-away).
func captureTypingField() {
	_, err := comThread.call(func(state *uiaState) (any, error) {
		releasePendingField()
		rec, err := uiaRecordedElement(state, "focus", 0, 0)
		if err != nil {
			return nil, err
		}
		elem, err := uiaGetFocusedElement(state.automation)
		if err != nil {
			return nil, err
		}
		recPendingElem = elem
		recPendingInfo = rec
		return nil, nil
	})
	if err != nil {
		log.Printf("[recorder] capture failed (typing): %v", err)
	}
}

// flushTypingField emits the pending field as a set_value carrying its
// current Value-pattern text (none for a secure field).
func flushTypingField() {
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
	// The value itself is never logged.
	log.Printf("[recorder] set_value: %s %q (secure=%v, app=%s)", rec.Role, rec.Name, rec.Secure, rec.App)
	emitInteraction(payload)
}

// captureClick hit-tests the click point after a short settle so the
// element reflects the just-finished action.
func captureClick(x, y int) {
	time.Sleep(60 * time.Millisecond)
	val, err := comThread.call(func(state *uiaState) (any, error) {
		return uiaRecordedElement(state, "click", x, y)
	})
	if err != nil {
		log.Printf("[recorder] capture failed (click at %d,%d): %v", x, y, err)
		return
	}
	rec, ok := val.(*recordedElement)
	if !ok || rec == nil {
		return
	}
	payload := interactionPayload(rec)
	payload["action"] = "click"
	log.Printf("[recorder] click: %s %q (app=%s)", rec.Role, rec.Name, rec.App)
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
