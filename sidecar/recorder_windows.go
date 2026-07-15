//go:build windows

package main

// recorder_windows.go — learn-by-watching input capture.
//
// Installs global low-level mouse + keyboard hooks (WH_MOUSE_LL / WH_KEYBOARD_LL)
// on a dedicated OS thread. It never swallows input (returns via CallNextHookEx
// always) — it only observes. On each meaningful commit it captures the
// currently-focused UIA element via the shared COM thread and emits a
// ui_interaction event:
//   • left mouse up  → flush any pending typed text, then emit a `click` on the
//                       element that had focus
//   • Enter / Tab    → flush pending typed text as a `set_value`
//   • printable keys  → accumulate into the type buffer (not the keystrokes
//                       themselves — we store the field's final value)
//
// The type buffer holds only that we *typed into a field*; the field's actual
// committed value + secure flag come from UIA at flush time, so passwords are
// marked secure and redacted brain-side. Keystroke content is not transmitted.

import (
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	whKeyboardLL = 13
	wmKeyDown    = 0x0100
	wmSysKeyDown = 0x0104
	// wmLButtonUp (0x0202) is declared in sub_pebble_overlay_windows.go.

	vkReturnRec = 0x0D
	vkTabRec    = 0x09
)

// kbdllHookStruct — WH_KEYBOARD_LL callback payload.
type kbdllHookStruct struct {
	VkCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

type recorderHook struct {
	stopCh   chan struct{}
	tid      uint32
	typed    atomic.Bool // whether printable keys arrived since the last flush
	mu       sync.Mutex
	stopOnce sync.Once
}

var activeRecorderHook *recorderHook

// startInputRecording installs the hooks. Called from handleRecorderStart.
func startInputRecording() error {
	h := &recorderHook{stopCh: make(chan struct{})}

	// Event channel drains on a worker goroutine so the hook procs stay cheap
	// (Windows blocks on their return for every input event system-wide).
	type ev struct {
		kind string // "click" | "commit"
	}
	evCh := make(chan ev, 64)

	go func() {
		for {
			select {
			case <-h.stopCh:
				return
			case e := <-evCh:
				captureFocusedAndEmit(e.kind, &h.typed)
			}
		}
	}()

	mouseProc := syscall.NewCallback(func(nCode int32, wParam uintptr, lParam uintptr) uintptr {
		if nCode >= 0 && wParam == wmLButtonUp {
			select {
			case evCh <- ev{kind: "click"}:
			default:
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
				select {
				case evCh <- ev{kind: "commit"}:
				default:
				}
			default:
				// Mark that the user is typing into the focused field. We do
				// NOT record the character — the committed field value is read
				// from UIA at flush time instead.
				if isPrintableVk(ks.VkCode) {
					h.typed.Store(true)
				}
			}
		}
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	})

	hookReady := make(chan bool, 1)
	tidCh := make(chan uint32, 1)

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		tid, _, _ := procGetCurrentThread.Call()
		tidCh <- uint32(tid)

		hMod, _, _ := procGetModuleHandleW.Call(0)
		hMouse, _, _ := procSetWindowsHookExW.Call(uintptr(whMouseLL), mouseProc, hMod, 0)
		hKey, _, _ := procSetWindowsHookExW.Call(uintptr(whKeyboardLL), keyboardProc, hMod, 0)
		if hMouse == 0 || hKey == 0 {
			if hMouse != 0 {
				procUnhookWindowsHookEx.Call(hMouse)
			}
			if hKey != 0 {
				procUnhookWindowsHookEx.Call(hKey)
			}
			hookReady <- false
			return
		}
		hookReady <- true

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
	if !<-hookReady {
		close(h.stopCh)
		return syscall.GetLastError()
	}

	h.mu.Lock()
	activeRecorderHook = h
	h.mu.Unlock()
	return nil
}

func stopInputRecording() {
	if activeRecorderHook == nil {
		return
	}
	h := activeRecorderHook
	activeRecorderHook = nil
	h.stopOnce.Do(func() {
		close(h.stopCh)
		procPostThreadMsg.Call(uintptr(h.tid), wmQuit, 0, 0)
	})
}

// captureFocusedAndEmit reads the focused element via the COM thread and emits
// the interaction. For a "commit" it emits set_value only if the user has been
// typing; a "click" always emits and flushes the type flag.
func captureFocusedAndEmit(kind string, typed *atomic.Bool) {
	// Small settle so focus/value reflect the just-finished action.
	time.Sleep(60 * time.Millisecond)

	val, err := comThread.call(func(state *uiaState) (any, error) {
		return uiaFocusedElementInfo(state)
	})
	if err != nil {
		return
	}
	info, ok := val.(*focusedElementInfo)
	if !ok || info == nil {
		return
	}

	wasTyping := typed.Swap(false)
	payload := map[string]any{
		"surface": "desktop",
		"ts":      time.Now().UnixMilli(),
		"secure":  info.Secure,
		"ref": map[string]any{
			"role":     info.Role,
			"name":     info.Name,
			"stableId": info.AutoID,
			"path":     []any{},
			"ordinal":  0,
			"sig":      info.Sig,
		},
	}

	if kind == "commit" {
		if !wasTyping {
			return // Enter/Tab with no typing — navigation, not a field commit
		}
		payload["action"] = "set_value"
		// The field's committed value comes from UIA; a secure field yields no
		// value (masked), which the brain treats as a redacted secret.
		if v, err := comThread.call(func(state *uiaState) (any, error) {
			return uiaFocusedValue(state)
		}); err == nil {
			if s, ok := v.(string); ok && !info.Secure {
				payload["value"] = s
			}
		}
	} else {
		payload["action"] = "click"
	}
	emitInteraction(payload)
}

// isPrintableVk reports whether a virtual-key code is a text-producing key
// (letters, digits, common punctuation) — used only to set the "typing" flag.
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
