//go:build windows

package main

// Native Win32 window enumeration, focus, and keyboard input.
//
// These replace the previous PowerShell implementations, which spawned a new
// powershell.exe per call and — for list_windows/focus_window — recompiled
// embedded C# via Add-Type on every single call (~0.7-1.5s each). The
// direct syscalls below complete in microseconds and cannot silently lose
// keystrokes the way SendKeys could (SendInput injects Unicode directly, no
// metacharacter escaping needed).

import (
	"fmt"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	procEnumWindows        = user32.NewProc("EnumWindows")
	procIsWindowVisible    = user32.NewProc("IsWindowVisible")
	procIsIconic           = user32.NewProc("IsIconic")
	procGetWindowTextW     = user32.NewProc("GetWindowTextW")
	procGetClassNameW      = user32.NewProc("GetClassNameW")
	procSendInput          = user32.NewProc("SendInput")
	procVkKeyScanW         = user32.NewProc("VkKeyScanW")
	procOpenProcess        = kernel32.NewProc("OpenProcess")
	procNativeCloseHandle  = kernel32.NewProc("CloseHandle")
	procQueryFullImageName = kernel32.NewProc("QueryFullProcessImageNameW")
	procWindowFromPoint    = user32.NewProc("WindowFromPoint")
	procScreenToClient     = user32.NewProc("ScreenToClient")
	procChildWindowFromPt  = user32.NewProc("ChildWindowFromPointEx")
	// procPostMessageW is declared in panels_windows.go.
)

// Background-click Win32 message constants (wmLButtonUp 0x0202 is declared in
// sub_pebble_overlay_windows.go as wmLButtonUp; we post it via that name).
const (
	wmLButtonDown  = 0x0201
	wmLButtonUpMsg = 0x0202
)

type w32Pt struct{ X, Y int32 }

// postMessageClick delivers a left click at screen (x, y) to the window under
// that point WITHOUT moving the real cursor or changing focus — the mechanism
// behind ghost mode. It posts WM_LBUTTONDOWN/UP with client-relative
// coordinates. Returns false when no target window is found (caller should
// report background_unavailable and offer the foreground path).
func postMessageClick(x, y int) bool {
	pt := w32Pt{X: int32(x), Y: int32(y)}
	// WindowFromPoint takes the POINT by value (packed into one uintptr on amd64).
	packed := uintptr(uint32(pt.X)) | (uintptr(uint32(pt.Y)) << 32)
	hwnd, _, _ := procWindowFromPoint.Call(packed)
	if hwnd == 0 {
		return false
	}
	// Descend to the deepest child at the point so the message reaches the
	// actual control, not just the top-level window.
	client := pt
	procScreenToClient.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	childPacked := uintptr(uint32(client.X)) | (uintptr(uint32(client.Y)) << 32)
	const cwpAll = 0x0000
	if child, _, _ := procChildWindowFromPt.Call(hwnd, childPacked, cwpAll); child != 0 && child != hwnd {
		hwnd = child
		client = pt
		procScreenToClient.Call(hwnd, uintptr(unsafe.Pointer(&client)))
	}

	lparam := uintptr(uint32(client.X)&0xFFFF) | (uintptr(uint32(client.Y)&0xFFFF) << 16)
	const mkLButton = 0x0001
	procPostMessageW.Call(hwnd, wmLButtonDown, mkLButton, lparam)
	procPostMessageW.Call(hwnd, wmLButtonUpMsg, 0, lparam)
	return true
}

// windowInfo describes one visible top-level window. JSON keys match the
// shape the previous PowerShell implementation produced, so daemon-side
// consumers see no change.
type windowInfo struct {
	Hwnd         uintptr `json:"hwnd"`
	Title        string  `json:"title"`
	Pid          uint32  `json:"pid"`
	ProcessName  string  `json:"process_name"`
	ClassName    string  `json:"class_name"`
	Left         int32   `json:"left"`
	Top          int32   `json:"top"`
	Right        int32   `json:"right"`
	Bottom       int32   `json:"bottom"`
	IsForeground bool    `json:"is_foreground"`
}

type win32Rect struct {
	Left, Top, Right, Bottom int32
}

// EnumWindows delivers results through a C-style callback with no closure
// support, so the collector is package state guarded by a mutex.
// syscall.NewCallback registrations are permanent, hence the sync.Once.
var (
	enumMu      sync.Mutex
	enumResults []windowInfo
	enumFg      uintptr
	enumCbOnce  sync.Once
	enumCb      uintptr
)

func enumWindowsCallback(hwnd uintptr, _ uintptr) uintptr {
	visible, _, _ := procIsWindowVisible.Call(hwnd)
	if visible == 0 {
		return 1 // continue enumeration
	}

	var titleBuf [256]uint16
	procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&titleBuf[0])), uintptr(len(titleBuf)))
	title := syscall.UTF16ToString(titleBuf[:])
	if strings.TrimSpace(title) == "" {
		return 1
	}

	var classBuf [256]uint16
	procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&classBuf[0])), uintptr(len(classBuf)))

	var rect win32Rect
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)))

	pid := win32GetWindowPid(hwnd)

	enumResults = append(enumResults, windowInfo{
		Hwnd:         hwnd,
		Title:        title,
		Pid:          pid,
		ProcessName:  processBaseName(pid),
		ClassName:    syscall.UTF16ToString(classBuf[:]),
		Left:         rect.Left,
		Top:          rect.Top,
		Right:        rect.Right,
		Bottom:       rect.Bottom,
		IsForeground: hwnd == enumFg,
	})
	return 1
}

// enumTopWindows returns all visible, titled top-level windows in z-order
// (topmost first). Safe to call from any goroutine; no COM required.
func enumTopWindows() []windowInfo {
	enumCbOnce.Do(func() {
		enumCb = syscall.NewCallback(enumWindowsCallback)
	})

	enumMu.Lock()
	defer enumMu.Unlock()
	enumResults = nil
	enumFg = win32GetForegroundWindow()
	procEnumWindows.Call(enumCb, 0)
	out := make([]windowInfo, len(enumResults))
	copy(out, enumResults)
	enumResults = nil
	return out
}

// processBaseName resolves a PID to its executable base name (without .exe),
// mirroring .NET's Process.ProcessName. Empty string when access is denied.
func processBaseName(pid uint32) string {
	const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
	h, _, _ := procOpenProcess.Call(PROCESS_QUERY_LIMITED_INFORMATION, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer procNativeCloseHandle.Call(h)

	var buf [512]uint16
	size := uint32(len(buf))
	ok, _, _ := procQueryFullImageName.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return ""
	}
	full := syscall.UTF16ToString(buf[:size])
	base := full
	if i := strings.LastIndexAny(full, `\/`); i >= 0 {
		base = full[i+1:]
	}
	return strings.TrimSuffix(base, ".exe")
}

// windowsForPid returns the visible windows owned by pid, z-order first.
func windowsForPid(pid int) []windowInfo {
	var out []windowInfo
	for _, w := range enumTopWindows() {
		if int(w.Pid) == pid {
			out = append(out, w)
		}
	}
	return out
}

// focusWindowNative restores (if minimized) and foregrounds the topmost
// window of pid. Returns the focused window, or an error naming what exists
// instead so the model can correct itself.
func focusWindowNative(pid int) (*windowInfo, error) {
	wins := windowsForPid(pid)
	if len(wins) == 0 {
		return nil, fmt.Errorf("no visible window for PID %d — %s", pid, windowInventoryHint())
	}
	w := wins[0]

	const SW_RESTORE = 9
	if minimized, _, _ := procIsIconic.Call(w.Hwnd); minimized != 0 {
		procShowWindow.Call(w.Hwnd, SW_RESTORE)
	}
	ok, _, _ := procSetForegroundWindow.Call(w.Hwnd)
	if ok == 0 {
		return &w, fmt.Errorf("could not bring %q (PID %d) to the foreground — Windows blocks focus stealing while the user is interacting with another app; ask the user to click the window, or retry after their input goes idle", w.Title, pid)
	}
	return &w, nil
}

// windowInventoryHint summarizes the current desktop for not-found errors.
func windowInventoryHint() string {
	wins := enumTopWindows()
	if len(wins) == 0 {
		return "no visible windows found at all"
	}
	max := len(wins)
	if max > 5 {
		max = 5
	}
	parts := make([]string, 0, max)
	for _, w := range wins[:max] {
		parts = append(parts, fmt.Sprintf("%q (pid %d, %s)", w.Title, w.Pid, w.ProcessName))
	}
	return "visible windows are: " + strings.Join(parts, ", ")
}

// waitForWindow polls for a visible window owned by pid, up to timeout.
// Modern Windows apps often hand the real window to a different process
// (packaged apps, brokers — e.g. calc.exe spawns Calculator.exe), so after
// half the timeout it also accepts a window whose process name matches
// exeBase. Returns the window and how it was matched, or nil.
func waitForWindow(pid int, exeBase string, timeout time.Duration) (*windowInfo, string) {
	exeBase = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(exeBase)), ".exe")
	deadline := time.Now().Add(timeout)
	half := time.Now().Add(timeout / 2)

	for {
		if wins := windowsForPid(pid); len(wins) > 0 {
			return &wins[0], "pid"
		}
		if exeBase != "" && time.Now().After(half) {
			for _, w := range enumTopWindows() {
				if strings.ToLower(w.ProcessName) == exeBase {
					return &w, "process_name"
				}
			}
		}
		if time.Now().After(deadline) {
			return nil, ""
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// ── SendInput keyboard injection ─────────────────────────────────────

const (
	inputKeyboard        = 1
	keyeventfExtendedKey = 0x0001
	keyeventfKeyUp       = 0x0002
	keyeventfUnicode     = 0x0004
)

// kbdInput is the Win32 INPUT struct specialized for keyboard events on
// amd64/arm64: 8-byte header (type + alignment padding), KEYBDINPUT payload,
// then padding out to the full 40-byte union size (MOUSEINPUT is larger).
type kbdInput struct {
	inputType uint32
	_         uint32
	vk        uint16
	scan      uint16
	flags     uint32
	time      uint32
	extraInfo uintptr
	_         [8]byte
}

func sendInputs(inputs []kbdInput) error {
	if len(inputs) == 0 {
		return nil
	}
	n, _, callErr := procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
	if int(n) != len(inputs) {
		return fmt.Errorf("SendInput injected %d of %d events: %v", n, len(inputs), callErr)
	}
	return nil
}

// typeTextNative types arbitrary text into the focused window as Unicode
// key events. No SendKeys metacharacters, no escaping, full Unicode
// (surrogate pairs included).
func typeTextNative(text string) error {
	units := utf16.Encode([]rune(text))
	inputs := make([]kbdInput, 0, len(units)*2)
	for _, u := range units {
		// '\n' arrives as a Unicode LF which most controls ignore; send a
		// real Enter keypress instead so multi-line text works.
		if u == '\n' {
			inputs = append(inputs,
				kbdInput{inputType: inputKeyboard, vk: vkReturn},
				kbdInput{inputType: inputKeyboard, vk: vkReturn, flags: keyeventfKeyUp},
			)
			continue
		}
		if u == '\r' {
			continue
		}
		inputs = append(inputs,
			kbdInput{inputType: inputKeyboard, scan: u, flags: keyeventfUnicode},
			kbdInput{inputType: inputKeyboard, scan: u, flags: keyeventfUnicode | keyeventfKeyUp},
		)
	}
	// Inject in bounded chunks: a single huge SendInput call is atomic and
	// can starve the receiving app's input queue.
	const chunk = 256
	for i := 0; i < len(inputs); i += chunk {
		end := i + chunk
		if end > len(inputs) {
			end = len(inputs)
		}
		if err := sendInputs(inputs[i:end]); err != nil {
			return err
		}
	}
	return nil
}

// Virtual-key codes for named keys.
const (
	vkBack     = 0x08
	vkTab      = 0x09
	vkReturn   = 0x0D
	vkShift    = 0x10
	vkMenu     = 0x12 // alt
	vkEscape   = 0x1B
	vkPageUp   = 0x21
	vkPageDown = 0x22
	vkEnd      = 0x23
	vkHome     = 0x24
	vkLeft     = 0x25
	vkUp       = 0x26
	vkRight    = 0x27
	vkDown     = 0x28
	vkInsert   = 0x2D
	vkDelete   = 0x2E
	vkLWin     = 0x5B
	vkF1       = 0x70
)

// extendedKeys need KEYEVENTF_EXTENDEDKEY for correct behavior.
var extendedKeys = map[uint16]bool{
	vkPageUp: true, vkPageDown: true, vkEnd: true, vkHome: true,
	vkLeft: true, vkUp: true, vkRight: true, vkDown: true,
	vkInsert: true, vkDelete: true, vkLWin: true,
}

var namedKeys = map[string]uint16{
	"enter": vkReturn, "return": vkReturn,
	"tab":       vkTab,
	"escape":    vkEscape,
	"esc":       vkEscape,
	"backspace": vkBack, "bs": vkBack,
	"delete": vkDelete, "del": vkDelete,
	"insert": vkInsert, "ins": vkInsert,
	"up": vkUp, "down": vkDown, "left": vkLeft, "right": vkRight,
	"home": vkHome, "end": vkEnd,
	"pageup": vkPageUp, "pgup": vkPageUp,
	"pagedown": vkPageDown, "pgdn": vkPageDown,
	"space": vkSpace,
}

var modifierKeys = map[string]uint16{
	"ctrl": vkControl, "control": vkControl,
	"alt":   vkMenu,
	"shift": vkShift,
	"win":   vkLWin, "windows": vkLWin, "meta": vkLWin, "super": vkLWin,
}

// resolveVk maps a key name to a virtual-key code.
func resolveVk(key string) (uint16, error) {
	k := strings.ToLower(strings.TrimSpace(key))
	if vk, ok := namedKeys[k]; ok {
		return vk, nil
	}
	if len(k) >= 2 && k[0] == 'f' {
		var n int
		if _, err := fmt.Sscanf(k, "f%d", &n); err == nil && n >= 1 && n <= 24 {
			return uint16(vkF1 + n - 1), nil
		}
	}
	if runes := []rune(k); len(runes) == 1 {
		res, _, _ := procVkKeyScanW.Call(uintptr(uint16(runes[0])))
		if low := uint16(res & 0xFF); low != 0xFF {
			return low, nil
		}
		return 0, fmt.Errorf("no virtual key for character %q on the current keyboard layout", key)
	}
	known := make([]string, 0, len(namedKeys))
	for name := range namedKeys {
		known = append(known, name)
	}
	return 0, fmt.Errorf("unknown key %q — use a single character, f1-f24, or one of: %s", key, strings.Join(known, ", "))
}

// pressKeysNative presses a modifier+key combination (e.g. ctrl+s, alt+f4,
// win+r) via SendInput. This makes the previously-broken `win` modifier a
// real Windows-key chord.
func pressKeysNative(keys string) error {
	parts := strings.Split(keys, ",")

	var mods []uint16
	var mains []uint16
	for _, part := range parts {
		p := strings.ToLower(strings.TrimSpace(part))
		if p == "" {
			continue
		}
		if vk, ok := modifierKeys[p]; ok {
			mods = append(mods, vk)
			continue
		}
		vk, err := resolveVk(p)
		if err != nil {
			return err
		}
		mains = append(mains, vk)
	}
	if len(mods) == 0 && len(mains) == 0 {
		return fmt.Errorf("no keys to press in %q", keys)
	}

	keyFlags := func(vk uint16) uint32 {
		if extendedKeys[vk] {
			return keyeventfExtendedKey
		}
		return 0
	}

	inputs := make([]kbdInput, 0, (len(mods)+len(mains))*2)
	for _, vk := range mods {
		inputs = append(inputs, kbdInput{inputType: inputKeyboard, vk: vk, flags: keyFlags(vk)})
	}
	for _, vk := range mains {
		inputs = append(inputs,
			kbdInput{inputType: inputKeyboard, vk: vk, flags: keyFlags(vk)},
			kbdInput{inputType: inputKeyboard, vk: vk, flags: keyFlags(vk) | keyeventfKeyUp},
		)
	}
	for i := len(mods) - 1; i >= 0; i-- {
		vk := mods[i]
		inputs = append(inputs, kbdInput{inputType: inputKeyboard, vk: vk, flags: keyFlags(vk) | keyeventfKeyUp})
	}
	return sendInputs(inputs)
}
