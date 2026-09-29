package main

// The keyspec layer every hotkey backend shares: one grammar, one set of key
// names, one modifier vocabulary, and the macOS match decision.
//
// Deliberately platform-independent and cgo-free, so all of it is reachable
// from a table test on any OS. That is the whole point of the file: the three
// backends touch OS APIs that cannot be exercised in CI on a foreign platform
// (`NSEvent` on macOS, `RegisterHotKey` on Windows, `XGrabKey` on X11), and
// before #563 the parsing that decides WHICH key they ask for lived inside each
// of them, untested and quietly divergent:
//
//   - `ctrl+left` and `ctrl+f13` parsed on Windows, and were REFUSED on Linux
//     (`XStringToKeysym` is case-sensitive: the keysym names are `Left` and
//     `F13`, and parseLinuxKeyspec lowercases the spec) and on macOS (no arrows
//     or F-keys in the key-code table at all).
//   - `ctrl+tab` parsed on Windows and macOS and was refused on Linux, for the
//     same case-sensitivity reason (`Tab`).
//   - `command+k` parsed on macOS and Windows and was refused on Linux, which
//     accepted `cmd`, `super`, `win` and `meta` but not `command`.
//
// A hotkey that ships as one default for all three platforms cannot live with
// that, so the grammar is resolved here once and each backend only translates a
// canonical key name into its own code.

import (
	"fmt"
	"strconv"
	"strings"
)

// maxKeyspecLen is a sanity bound on an incoming keyspec. "ctrl+shift+space"
// is 16 bytes; anything approaching this is a mistake or an attack.
const maxKeyspecLen = 128

// hotkeyMods is the set of modifiers a spec asks for, independent of any OS's
// bit layout. Each backend converts it with its own function below.
type hotkeyMods uint8

const (
	hotkeyModShift hotkeyMods = 1 << iota
	hotkeyModControl
	hotkeyModOption
	hotkeyModCommand
)

// hotkeySpec is a parsed keyspec: the modifiers, and the canonical name of the
// one key they go with.
type hotkeySpec struct {
	Mods hotkeyMods
	Key  string
}

// modifierNames is the accepted vocabulary, unified across the three backends
// so one config value means the same thing everywhere.
//
// `cmd`, `command`, `super`, `win` and `meta` are one modifier with five names
// because they are one key in practice -- Command on macOS, the Windows key on
// Windows, Mod4 on X11. Note for anyone choosing a DEFAULT with it: all three
// platforms reserve that key's Space combination (Spotlight, the Windows
// language switch, the GNOME input-source switch), so it is a poor choice for a
// binding that ships to everybody.
var modifierNames = map[string]hotkeyMods{
	"ctrl":    hotkeyModControl,
	"control": hotkeyModControl,
	"shift":   hotkeyModShift,
	"alt":     hotkeyModOption,
	"opt":     hotkeyModOption,
	"option":  hotkeyModOption,
	"cmd":     hotkeyModCommand,
	"command": hotkeyModCommand,
	"super":   hotkeyModCommand,
	"win":     hotkeyModCommand,
	"meta":    hotkeyModCommand,
}

// keyAliases folds the spellings a user might write onto one canonical name.
// The canonical names are the keys of the three code tables below.
var keyAliases = map[string]string{
	// No " " entry: parseKeyspec TrimSpaces every token, so a key token that is
	// a literal space arrives here as "" and is rejected before the lookup.
	// (The old Linux and macOS parsers trimmed only the whole string, so
	// `summon_hotkey: "ctrl+ "` used to resolve to Space on those two. Nothing
	// could send that value -- the keyspec was hardcoded -- and Windows already
	// rejected it.)
	"spacebar": "space",
	"enter":    "return",
	"esc":      "escape",
	"del":      "delete",
	"ins":      "insert",
	"pgup":     "pageup",
	"pgdn":     "pagedown",
	"pagedn":   "pagedown",
	"-":        "minus",
	"=":        "equal",
	"[":        "leftbracket",
	"]":        "rightbracket",
	"\\":       "backslash",
	";":        "semicolon",
	"'":        "quote",
	",":        "comma",
	".":        "period",
	"/":        "slash",
	"`":        "grave",
}

// canonicalKeyName resolves one key token to its canonical name. Unknown tokens
// come back unchanged: the Linux backend still hands anything it does not
// recognise to `XStringToKeysym`, and refusing them here would narrow what
// already works.
//
// Only the LOWERCASE half of the keysym namespace is reachable that way, since
// parseKeyspec lower-cases the whole spec first: `yen` and `mu` resolve, `Menu`
// and `Hiragana_Katakana` do not. Pre-existing, and the table above is how a
// key that needs a capitalised keysym name (`Tab`, `F13`, `Left`) is reached.
func canonicalKeyName(token string) string {
	if canon, ok := keyAliases[token]; ok {
		return canon
	}
	// Normalise a zero-padded function key. Windows and Linux compute these
	// with strconv.Atoi, so "f013" resolved there while macOS -- a literal map
	// lookup -- refused it, which is exactly the one-spelling-means-one-key
	// rule this file exists to hold.
	if n, ok := functionKeyNumber(token); ok {
		return "f" + strconv.Itoa(n)
	}
	return token
}

// functionKeyNumber reads "f13" (or "f013") as 13. The bound is the widest any
// backend accepts; each one narrows it further with its own table or range.
func functionKeyNumber(token string) (int, bool) {
	if len(token) < 2 || token[0] != 'f' {
		return 0, false
	}
	n, err := strconv.Atoi(token[1:])
	if err != nil || n < 1 || n > 35 {
		return 0, false
	}
	return n, true
}

// parseKeyspec reads "ctrl+shift+space", "Cmd+K" or "f13": the last
// `+`-separated token is the key, everything before it is a modifier, case does
// not matter, and a key with no modifier at all is allowed (`f13` is a
// legitimate binding).
func parseKeyspec(spec string) (hotkeySpec, error) {
	// Bounded before ToLower+Split, which together allocate a copy plus a
	// string header per token -- roughly 16x the input. The spec arrives over
	// the daemon RPC, whose read limit is 10 MiB, and no real keyspec is
	// anywhere near this. The daemon truncates the value in its own log line
	// for the same reason (describeValue in src/config/pebble-hotkeys.ts).
	if len(spec) > maxKeyspecLen {
		return hotkeySpec{}, fmt.Errorf("hotkey spec is %d bytes; the limit is %d", len(spec), maxKeyspecLen)
	}
	parts := strings.Split(strings.ToLower(strings.TrimSpace(spec)), "+")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	keyTok := parts[len(parts)-1]
	if keyTok == "" {
		return hotkeySpec{}, fmt.Errorf("hotkey %q names no key", spec)
	}
	var mods hotkeyMods
	for _, m := range parts[:len(parts)-1] {
		bit, ok := modifierNames[m]
		if !ok {
			return hotkeySpec{}, fmt.Errorf("unknown modifier %q in hotkey %q", m, spec)
		}
		mods |= bit
	}
	return hotkeySpec{Mods: mods, Key: canonicalKeyName(keyTok)}, nil
}

// ---------------------------------- macOS ----------------------------------

// NSEventModifierFlags, device-independent subset.
const (
	nsModShift   = 1 << 17
	nsModControl = 1 << 18
	nsModOption  = 1 << 19
	nsModCommand = 1 << 20
)

// darwinModifierCompareMask is the ONLY part of `[NSEvent modifierFlags]` a
// hotkey comparison may look at, and the reason exact matching needed thinking
// about rather than just changing `(got & want) == want` into `got == want`.
//
// `NSEventModifierFlagDeviceIndependentFlagsMask`, which the monitor used to
// compare against, also carries CapsLock (1<<16), NumericPad (1<<21), Help
// (1<<22) and Function (1<<23). macOS sets Function on every F-key, on the
// arrows, and on Home/End/PageUp/PageDown/forward-Delete, plus NumericPad on
// the arrows, so a literal `got == want` would have made `f13`, `up` and `home`
// impossible to press -- and Caps Lock being on would
// have silently disabled every hotkey on the machine. The raw flags also carry
// device-DEPENDENT bits in the low byte (which physical Shift, which physical
// Control), which are not part of what the user asked for either.
//
// So only the four modifiers a person can deliberately hold are compared.
const darwinModifierCompareMask = nsModShift | nsModControl | nsModOption | nsModCommand

// darwinModifierMask converts parsed modifiers into NSEventModifierFlags. The
// result is always inside darwinModifierCompareMask, which is what makes the
// `got == want` comparison in the monitor a fair one.
func darwinModifierMask(mods hotkeyMods) uint {
	var flags uint
	if mods&hotkeyModShift != 0 {
		flags |= nsModShift
	}
	if mods&hotkeyModControl != 0 {
		flags |= nsModControl
	}
	if mods&hotkeyModOption != 0 {
		flags |= nsModOption
	}
	if mods&hotkeyModCommand != 0 {
		flags |= nsModCommand
	}
	return flags
}

// darwinHotkeyMatches is the decision the `NSEvent` global monitor makes on
// every key-down in the session, written here so it can be tested.
//
// The monitor cannot call into Go per keystroke (that would cross the cgo
// boundary for every key pressed anywhere on the machine), so the C block
// applies `gotFlags & compareMask == wantFlags` itself -- but BOTH the mask and
// the already-masked wantFlags are passed in from Go, so this function and the
// monitor cannot disagree about which bits matter or what was asked for.
//
// EXACT, not superset: before #563 the monitor tested `(got & want) == want`, so
// a `ctrl+space` binding also fired on Ctrl+Cmd+Space (the Character Viewer),
// Ctrl+Shift+Space and Ctrl+Option+Space. That is a user-visible change -- an
// extra modifier held out of habit no longer triggers the hotkey.
func darwinHotkeyMatches(gotFlags uint, gotKeyCode uint16, wantFlags uint, wantKeyCode uint16) bool {
	if gotKeyCode != wantKeyCode {
		return false
	}
	// wantFlags is NOT masked here, because the C block does not mask it either
	// -- it compares `([e modifierFlags] & cmp) == want`. Masking it on this
	// side would make this function forgiving where the monitor is not, and
	// would hide exactly the failure the "a parsed mask never reaches outside
	// the compare mask" test exists to catch: a want with a stray bit makes the
	// hotkey silently DEAD, not over-firing.
	return gotFlags&darwinModifierCompareMask == wantFlags
}

// darwinKeyCodes maps canonical key names to macOS HARDWARE key codes (the
// `kVK_*` constants from HIToolbox/Events.h).
//
// These are physical POSITIONS on a US-ANSI keyboard, not characters: `[e
// keyCode]` reports where the key is, never what it types. So on AZERTY, `q`
// addresses the position labelled `a`. Windows and X11 both resolve a key name
// through the ACTIVE LAYOUT instead, so the same name can mean a different
// physical key on macOS than on the other two for the same user. Documented in
// docs/PEBBLE_HOTKEYS.md, and the reason a default that ships to everybody is
// better off on `space` or an F-key, which sit in the same place in every
// layout.
var darwinKeyCodes = map[string]uint16{
	// Letters (kVK_ANSI_A ...).
	"a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
	"j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12,
	"r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
	// Digits.
	"1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
	// Named keys. "return" is kVK_Return, the main Return key; the numeric
	// keypad's Enter is a different key (kVK_ANSI_KeypadEnter, 76), which
	// Windows cannot tell apart from Return at all (both are VK_RETURN).
	"return": 36, "tab": 48, "space": 49, "escape": 53, "backspace": 51,
	"delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
	"left": 123, "right": 124, "down": 125, "up": 126,
	// Punctuation, by US-ANSI position.
	"minus": 27, "equal": 24, "leftbracket": 33, "rightbracket": 30,
	"backslash": 42, "semicolon": 41, "quote": 39, "comma": 43, "period": 47,
	"slash": 44, "grave": 50,
	// Function keys. F13-F19 are unbound on stock macOS, which makes them
	// attractive -- but they are absent from every current laptop keyboard, so
	// they are free and unreachable at once: fine as a documented choice for a
	// user with a full-size keyboard, wrong as a shipped default.
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
	"f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105,
	"f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
}

// darwinKeyCode resolves a canonical key name to a macOS hardware key code.
//
// macOS has NO key code for "insert": the position a PC keyboard labels Insert
// is Help (kVK_Help, 114) on an Apple Extended Keyboard and absent from every
// other one, so an `insert` binding is refused here rather than silently
// pointing at a key the user does not have.
func darwinKeyCode(key string) (uint16, bool) {
	code, ok := darwinKeyCodes[key]
	return code, ok
}

// parseDarwinKeyspec turns a keyspec into NSEventModifierFlags plus a macOS
// hardware key code. Pure Go and cgo-free on purpose, so it is covered by the
// table test on Linux; hotkeys_darwin.go only installs the monitor.
func parseDarwinKeyspec(spec string) (mods uint, keyCode uint16, err error) {
	parsed, err := parseKeyspec(spec)
	if err != nil {
		return 0, 0, err
	}
	code, ok := darwinKeyCode(parsed.Key)
	if !ok {
		return 0, 0, fmt.Errorf("unsupported key %q in hotkey %q on macOS", parsed.Key, spec)
	}
	return darwinModifierMask(parsed.Mods), code, nil
}

// --------------------------------- Windows ---------------------------------

// Win32 hotkey modifier flags (MOD_*), for RegisterHotKey.
const (
	modAlt     = 0x0001
	modControl = 0x0002
	modShift   = 0x0004
	modWin     = 0x0008
)

const (
	vkSpace = 0x20
	vkF1    = 0x70 // VK_F1; F2..F24 follow contiguously
)

// windowsModifierMask converts parsed modifiers into Win32 MOD_* flags.
func windowsModifierMask(mods hotkeyMods) uint32 {
	var flags uint32
	if mods&hotkeyModShift != 0 {
		flags |= modShift
	}
	if mods&hotkeyModControl != 0 {
		flags |= modControl
	}
	if mods&hotkeyModOption != 0 {
		flags |= modAlt
	}
	if mods&hotkeyModCommand != 0 {
		flags |= modWin
	}
	return flags
}

// namedVKCodes covers the canonical key names that have a name rather than a
// character. Letters, digits and the function keys are computed in windowsVK.
var namedVKCodes = map[string]uint32{
	"space":     vkSpace,
	"return":    0x0D, // VK_RETURN -- the keypad's Enter is the same VK on Windows
	"tab":       0x09,
	"escape":    0x1B,
	"backspace": 0x08,
	"delete":    0x2E,
	"insert":    0x2D,
	"home":      0x24,
	"end":       0x23,
	"pageup":    0x21, // VK_PRIOR
	"pagedown":  0x22, // VK_NEXT
	"left":      0x25,
	"up":        0x26,
	"right":     0x27,
	"down":      0x28,
	// OEM punctuation. These are US-layout names for keys whose VK the active
	// layout produces, which is the same caveat as everywhere else on Windows.
	"minus":        0xBD, // VK_OEM_MINUS
	"equal":        0xBB, // VK_OEM_PLUS
	"leftbracket":  0xDB, // VK_OEM_4
	"rightbracket": 0xDD, // VK_OEM_6
	"backslash":    0xDC, // VK_OEM_5
	"semicolon":    0xBA, // VK_OEM_1
	"quote":        0xDE, // VK_OEM_7
	"comma":        0xBC, // VK_OEM_COMMA
	"period":       0xBE, // VK_OEM_PERIOD
	"slash":        0xBF, // VK_OEM_2
	"grave":        0xC0, // VK_OEM_3
}

// windowsVK resolves one canonical key name to a Win32 virtual-key code.
// Letters, digits and F1-F24 are computed (the VK ranges are contiguous and
// match ASCII for the first two); everything else comes from namedVKCodes.
func windowsVK(name string) (uint32, bool) {
	if len(name) == 1 {
		switch c := name[0]; {
		case c >= 'a' && c <= 'z':
			return uint32(c-'a') + 0x41, true // VK_A..VK_Z are 'A'..'Z'
		case c >= '0' && c <= '9':
			return uint32(c-'0') + 0x30, true // VK_0..VK_9 are '0'..'9'
		}
	}
	// Guarded by the single-character case above, so a bare "f" is the letter.
	if len(name) > 1 && name[0] == 'f' {
		if n, err := strconv.Atoi(name[1:]); err == nil && n >= 1 && n <= 24 {
			return vkF1 + uint32(n) - 1, true
		}
	}
	vk, ok := namedVKCodes[name]
	return vk, ok
}

// parseHotkey converts a keyspec into Win32 modifier flags and a virtual-key
// code. Kept as the name hotkeys_windows.go calls, and pure Go so the Windows
// key table is covered by the table test on Linux -- the Windows backend's own
// test is `//go:build windows` and never runs in a Linux CI job.
func parseHotkey(spec string) (mods, vk uint32, err error) {
	parsed, err := parseKeyspec(spec)
	if err != nil {
		return 0, 0, err
	}
	vk, ok := windowsVK(parsed.Key)
	if !ok {
		return 0, 0, fmt.Errorf("unsupported key %q in hotkey %q on Windows", parsed.Key, spec)
	}
	return windowsModifierMask(parsed.Mods), vk, nil
}

// ---------------------------------- Linux ----------------------------------

// X11 modifier masks (from X.h).
const (
	hkShiftMask   = 1 << 0 // ShiftMask
	hkControlMask = 1 << 2 // ControlMask
	hkMod1Mask    = 1 << 3 // Mod1Mask (Alt)
	hkMod4Mask    = 1 << 6 // Mod4Mask (Super)
)

// linuxModifierMask converts parsed modifiers into an X11 modifier mask.
func linuxModifierMask(mods hotkeyMods) uint {
	var flags uint
	if mods&hotkeyModShift != 0 {
		flags |= hkShiftMask
	}
	if mods&hotkeyModControl != 0 {
		flags |= hkControlMask
	}
	if mods&hotkeyModOption != 0 {
		flags |= hkMod1Mask
	}
	if mods&hotkeyModCommand != 0 {
		flags |= hkMod4Mask
	}
	return flags
}

// linuxKeysymNames maps canonical key names to X11 keysym names, which are
// CASE-SENSITIVE and not always the obvious spelling (`Prior` for Page Up,
// `bracketleft` for `[`, `apostrophe` for `'`). Everything absent from this map
// is handed to `XStringToKeysym` as written -- letters and digits are already
// their own keysym names, and so is a great deal of punctuation this file does
// not enumerate.
var linuxKeysymNames = map[string]string{
	"space":        "space",
	"return":       "Return",
	"tab":          "Tab",
	"escape":       "Escape",
	"backspace":    "BackSpace",
	"delete":       "Delete",
	"insert":       "Insert",
	"home":         "Home",
	"end":          "End",
	"pageup":       "Prior",
	"pagedown":     "Next",
	"left":         "Left",
	"right":        "Right",
	"up":           "Up",
	"down":         "Down",
	"minus":        "minus",
	"equal":        "equal",
	"leftbracket":  "bracketleft",
	"rightbracket": "bracketright",
	"backslash":    "backslash",
	"semicolon":    "semicolon",
	"quote":        "apostrophe",
	"comma":        "comma",
	"period":       "period",
	"slash":        "slash",
	"grave":        "grave",
}

// hkGrab* are the outcomes jarvisHotkeyCreate reports.
//
// KEEP IN SYNC with the HK_* enum in the cgo preamble of hotkeys_linux.go.
// They live here, away from the build tag, so the message wording below is a
// pure function the table test can cover on any OS -- the grab itself is in
// the cgo half and no test can reach it, which is exactly why the part that
// CAN be tested was pulled out of it.
const (
	hkGrabOK        = 0
	hkGrabNoDisplay = 1
	hkGrabNoKeycode = 2
	hkGrabRefused   = 3
	hkGrabNoPipe    = 4
	hkGrabNoMem     = 5
)

// X11 protocol constants (X.h / Xproto.h), repeated here so this file stays
// cgo-free.
const (
	hkBadAccess   = 10  // BadAccess: someone else already holds this grab
	hkOpcodeGrab  = 33  // X_GrabKey
	hkNumVariants = 4   // len(HK_VARIANTS)
	hkAllVariants = 0xf // every variant bit set
)

// hkVariantNames names the lock-key modifier variants by bit position, in the
// order of HK_VARIANTS in hotkeys_linux.go.
var hkVariantNames = [hkNumVariants]string{"plain", "CapsLock", "NumLock", "CapsLock+NumLock"}

// hkFailedVariantList renders a failed_mask as "CapsLock, NumLock".
func hkFailedVariantList(mask uint) string {
	var names []string
	for i := range hkVariantNames {
		if mask&(1<<uint(i)) != 0 {
			names = append(names, hkVariantNames[i])
		}
	}
	return strings.Join(names, ", ")
}

// linuxGrabError turns a create outcome into something a user can act on, the
// way registerHotKeyError does on Windows -- same `Call(keyspec): reason`
// shape, and the same refusal to name a culprit it cannot actually identify.
//
// The one thing it says that Windows does not is WHICH lock variants clashed,
// because on X11 a combination can be refused for Caps Lock alone. That is not
// naming a culprit, it is naming which of our own four requests was turned
// down, and it is the difference between "the combination is taken" and "your
// desktop holds the Caps Lock variant of it".
//
// The old message conflated "no display" with "no such key" into a single
// `XGrabKey failed for %q (no display or key unavailable)`; they are now
// separate, since one means the session cannot do global hotkeys at all and
// the other means this particular keyspec is wrong for the active layout.
// nilHandle says the create produced no Hotkey. It is passed separately from
// stage because the two can disagree, and when they do this function must NOT
// fail open: returning nil for a create that handed back nothing would put the
// caller straight back to logging "registered" for a hotkey that cannot fire,
// which is #574 verbatim, reached through the guard that exists to prevent it.
func linuxGrabError(keyspec string, stage int, errorCode, requestCode uint8, failedMask uint, nilHandle bool) error {
	switch stage {
	case hkGrabOK:
		if nilHandle {
			return fmt.Errorf("XGrabKey(%s): the grab reported success but produced no listener (internal inconsistency)", keyspec)
		}
		return nil
	case hkGrabNoDisplay:
		return fmt.Errorf("XGrabKey(%s): no X display (DISPLAY unset, or a native Wayland session with no XWayland)", keyspec)
	case hkGrabNoKeycode:
		return fmt.Errorf("XGrabKey(%s): the active keyboard layout has no key for this keysym", keyspec)
	case hkGrabNoPipe:
		return fmt.Errorf("XGrabKey(%s): could not set up the listener's stop pipe", keyspec)
	case hkGrabNoMem:
		return fmt.Errorf("XGrabKey(%s): out of memory allocating the listener", keyspec)
	case hkGrabRefused:
		// Say which variants, unless it was all of them (in which case the
		// combination is simply taken and the list adds nothing).
		var scope string
		if failedMask != hkAllVariants && failedMask != 0 {
			scope = fmt.Sprintf("; only the %s variant(s) clashed, and the grab is refused as a whole rather than leave a hotkey that works in some lock states and not others",
				hkFailedVariantList(failedMask))
		}
		if errorCode == hkBadAccess && requestCode == hkOpcodeGrab {
			return fmt.Errorf("XGrabKey(%s): already held by another client (another app, your desktop, or a sidecar that has not exited)%s", keyspec, scope)
		}
		return fmt.Errorf("XGrabKey(%s): refused with X error %d on request %d%s", keyspec, errorCode, requestCode, scope)
	}
	// An unrecognised stage is a code bug, not something the X server did, so
	// it must not be dressed up as a refusal with a zero error code.
	return fmt.Errorf("XGrabKey(%s): unknown create outcome %d (hotkeys_linux.go and hotkeys_keyspec.go have drifted)", keyspec, stage)
}

// linuxKeysymName resolves a canonical key name to the string
// `XStringToKeysym` wants. F-keys are computed (`f13` -> `F13`).
func linuxKeysymName(key string) string {
	if name, ok := linuxKeysymNames[key]; ok {
		return name
	}
	if len(key) > 1 && key[0] == 'f' {
		if n, err := strconv.Atoi(key[1:]); err == nil && n >= 1 && n <= 35 {
			return "F" + strconv.Itoa(n)
		}
	}
	return key
}
