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
)

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

// visibleWindowHandles snapshots which windows are already on screen.
// Taken before a launch, it is what lets the process-name fallback below
// tell a window this launch produced from one that was already there.
func visibleWindowHandles() map[uintptr]bool {
	open := map[uintptr]bool{}
	for _, w := range enumTopWindows() {
		open[w.Hwnd] = true
	}
	return open
}

// waitForWindow polls for a visible window owned by pid, up to timeout.
// Modern Windows apps often hand the real window to a different process
// (packaged apps, brokers, e.g. calc.exe spawns Calculator.exe), so after
// half the timeout it also accepts a window whose process name matches
// exeBase. Returns the window and how it was matched, or nil.
//
// preexisting holds the windows that were already open when the launch
// started, and the name fallback skips them. Without that, launching an app
// that is already running and then fails to open a second window hands back
// the window from the first instance, and the caller reports a success it
// had no part in - against a PID the model will then try to drive.
func waitForWindow(pid int, exeBase string, timeout time.Duration, preexisting map[uintptr]bool) (*windowInfo, string) {
	exeBase = processBaseNameOf(exeBase)
	deadline := time.Now().Add(timeout)
	half := time.Now().Add(timeout / 2)

	for {
		// One enumeration per poll feeds both matches; asking twice was pure
		// duplicated work.
		if w, how := pickLaunchedWindow(enumTopWindows(), pid, exeBase, time.Now().After(half), preexisting); w != nil {
			return w, how
		}
		if time.Now().After(deadline) {
			return nil, ""
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// pickLaunchedWindow chooses, from the windows currently on screen, the one
// a launch produced. Split out from the polling so the matching rules can be
// tested without a desktop.
func pickLaunchedWindow(wins []windowInfo, pid int, exeBase string, allowNameMatch bool, preexisting map[uintptr]bool) (*windowInfo, string) {
	// A window owned by the PID we just started is ours by construction, so
	// this match needs no pre-existing guard.
	for i := range wins {
		if int(wins[i].Pid) == pid {
			return &wins[i], "pid"
		}
	}
	if !allowNameMatch || exeBase == "" {
		return nil, ""
	}
	for i := range wins {
		if preexisting[wins[i].Hwnd] {
			continue
		}
		if strings.ToLower(wins[i].ProcessName) == exeBase {
			return &wins[i], "process_name"
		}
	}
	return nil, ""
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

// The layout above is the 64-bit INPUT union. SendInput rejects any cbSize
// that is not the real size of the struct, so a build whose layout differs
// would fail on every single call at runtime. These fail to compile instead:
// both are [0]byte when the size is right, and one or the other blows up
// when it is not (a 32-bit windows build packs the union to 28 bytes).
var (
	_ [unsafe.Sizeof(kbdInput{}) - 40]byte
	_ [40 - unsafe.Sizeof(kbdInput{})]byte
)

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

// keyEventsForRune renders one source character as SendInput events,
// appended to dst.
func keyEventsForRune(dst []kbdInput, r rune) []kbdInput {
	// '\n' arrives as a Unicode LF which most controls ignore; send a real
	// Enter keypress instead so multi-line text works.
	if r == '\n' {
		return append(dst,
			kbdInput{inputType: inputKeyboard, vk: vkReturn},
			kbdInput{inputType: inputKeyboard, vk: vkReturn, flags: keyeventfKeyUp},
		)
	}
	if r == '\r' {
		return dst
	}
	for _, u := range utf16.Encode([]rune{r}) {
		dst = append(dst,
			kbdInput{inputType: inputKeyboard, scan: u, flags: keyeventfUnicode},
			kbdInput{inputType: inputKeyboard, scan: u, flags: keyeventfUnicode | keyeventfKeyUp},
		)
	}
	return dst
}

// typeTextNative types arbitrary text into the focused window as Unicode
// key events. No SendKeys metacharacters, no escaping, full Unicode
// (surrogate pairs included).
//
// The text goes out in bounded chunks because a single huge SendInput call
// is atomic and can starve the receiving app's input queue. Chunk boundaries
// fall between source characters, never inside one: anything outside the BMP
// is a UTF-16 surrogate pair, and Windows expects both halves to arrive in
// the same SendInput call. Splitting one across two calls is how an emoji
// turns into a pair of replacement characters.
func typeTextNative(text string) error {
	const chunkTarget = 256

	inputs := make([]kbdInput, 0, chunkTarget+4)
	flush := func() error {
		if len(inputs) == 0 {
			return nil
		}
		if err := sendInputs(inputs); err != nil {
			return err
		}
		inputs = inputs[:0]
		return nil
	}

	var events []kbdInput
	for _, r := range text {
		events = keyEventsForRune(events[:0], r)
		if len(events) == 0 {
			continue
		}
		if len(inputs)+len(events) > chunkTarget {
			if err := flush(); err != nil {
				return err
			}
		}
		inputs = append(inputs, events...)
	}
	return flush()
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

// winNamedKeys maps key names to Windows virtual-key codes. Distinct from the
// CDP-oriented namedKeys in browser_input.go, which carries keyDef metadata.
var winNamedKeys = map[string]uint16{
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

// vkScanShiftState decodes the modifier bits VkKeyScanW packs into the high
// byte of its result.
func vkScanShiftState(state uint16) []uint16 {
	var implied []uint16
	if state&0x01 != 0 {
		implied = append(implied, vkShift)
	}
	if state&0x02 != 0 {
		implied = append(implied, vkControl)
	}
	if state&0x04 != 0 {
		implied = append(implied, vkMenu)
	}
	return implied
}

// resolveVk maps a key name to a virtual-key code, plus any modifiers the
// current keyboard layout needs held to produce it.
//
// There is no virtual key for "?" on a US layout: it is shift and the "/"
// key. VkKeyScanW says so in the high byte of its result, and dropping that
// byte is why asking for "?" used to press "/" - the wrong key, with no
// error to say so. Layouts differ in which characters need this, so the
// answer has to come from the layout rather than a table.
//
// The character is lowercased first, which is what keeps this from changing
// what a chord means. press_keys names keys, not text: "ctrl,S" is the same
// shortcut as "ctrl,s", so an uppercase letter must not quietly acquire the
// shift its capital form would need. Lowercasing leaves symbols untouched,
// so "?" still reports the shift it genuinely requires.
func resolveVk(key string) (uint16, []uint16, error) {
	k := strings.ToLower(strings.TrimSpace(key))
	if vk, ok := winNamedKeys[k]; ok {
		return vk, nil, nil
	}
	if len(k) >= 2 && k[0] == 'f' {
		var n int
		if _, err := fmt.Sscanf(k, "f%d", &n); err == nil && n >= 1 && n <= 24 {
			return uint16(vkF1 + n - 1), nil, nil
		}
	}
	if runes := []rune(k); len(runes) == 1 {
		res, _, _ := procVkKeyScanW.Call(uintptr(uint16(runes[0])))
		if low := uint16(res & 0xFF); low != 0xFF {
			return low, vkScanShiftState(uint16(res>>8) & 0xFF), nil
		}
		return 0, nil, fmt.Errorf("no virtual key for character %q on the current keyboard layout", key)
	}
	known := make([]string, 0, len(winNamedKeys))
	for name := range winNamedKeys {
		known = append(known, name)
	}
	return 0, nil, fmt.Errorf("unknown key %q - use a single character, f1-f24, or one of: %s", key, strings.Join(known, ", "))
}

// pressKeysNative presses a modifier+key combination (e.g. ctrl+s, alt+f4,
// win+r) via SendInput. This makes the previously-broken `win` modifier a
// real Windows-key chord.
func pressKeysNative(keys string) error {
	parts := strings.Split(keys, ",")

	var mods []uint16
	var mains []uint16
	held := map[uint16]bool{}
	addMod := func(vk uint16) {
		if !held[vk] {
			held[vk] = true
			mods = append(mods, vk)
		}
	}

	for _, part := range parts {
		raw := strings.TrimSpace(part)
		if raw == "" {
			continue
		}
		if vk, ok := modifierKeys[strings.ToLower(raw)]; ok {
			addMod(vk)
			continue
		}
		vk, implied, err := resolveVk(raw)
		if err != nil {
			return err
		}
		// A character that needs shift on this layout brings its own
		// modifier; an explicitly named one must not be pressed twice.
		for _, m := range implied {
			addMod(m)
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
