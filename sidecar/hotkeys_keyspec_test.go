package main

import (
	"fmt"
	"strings"
	"testing"
)

// The hotkey decisions that can be PROVEN off a Mac.
//
// hotkeys_darwin.go is //go:build darwin and cannot be compiled on the Linux/WSL
// box this is developed on, let alone run; hotkeys_windows_test.go is
// //go:build windows and never runs in a Linux CI job. So everything in
// hotkeys_keyspec.go is deliberately cgo-free and platform-independent, and this
// is where the parsing and the macOS match rule are pinned.

func TestParseKeyspec(t *testing.T) {
	t.Run("modifiers combine and case does not matter", func(t *testing.T) {
		got, err := parseKeyspec("Ctrl+Shift+Space")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Mods != hotkeyModControl|hotkeyModShift {
			t.Errorf("mods = %b, want ctrl|shift", got.Mods)
		}
		if got.Key != "space" {
			t.Errorf("key = %q, want space", got.Key)
		}
	})

	t.Run("every modifier spelling maps to the same four bits", func(t *testing.T) {
		for _, group := range [][]string{
			{"ctrl", "control"},
			{"shift"},
			{"alt", "opt", "option"},
			{"cmd", "command", "super", "win", "meta"},
		} {
			var first hotkeyMods
			for i, name := range group {
				spec, err := parseKeyspec(name + "+k")
				if err != nil {
					t.Fatalf("%q: unexpected error: %v", name, err)
				}
				if i == 0 {
					first = spec.Mods
					continue
				}
				if spec.Mods != first {
					t.Errorf("modifier %q = %b, want %b (same as %q)", name, spec.Mods, first, group[0])
				}
			}
		}
	})

	t.Run("a key with no modifier is allowed", func(t *testing.T) {
		got, err := parseKeyspec("f13")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Mods != 0 || got.Key != "f13" {
			t.Errorf("got %+v, want {0 f13}", got)
		}
	})

	t.Run("aliases fold onto one canonical name", func(t *testing.T) {
		for spec, want := range map[string]string{
			"ctrl+spacebar": "space",
			"ctrl+enter":    "return",
			"ctrl+return":   "return",
			"ctrl+esc":      "escape",
			"ctrl+del":      "delete",
			"ctrl+ins":      "insert",
			"ctrl+pgup":     "pageup",
			"ctrl+pgdn":     "pagedown",
			"ctrl+-":        "minus",
			"ctrl+=":        "equal",
			"ctrl+[":        "leftbracket",
			"ctrl+]":        "rightbracket",
			"ctrl+;":        "semicolon",
			"ctrl+'":        "quote",
			"ctrl+,":        "comma",
			"ctrl+.":        "period",
			"ctrl+/":        "slash",
			"ctrl+`":        "grave",
			"ctrl+\\":       "backslash",
		} {
			got, err := parseKeyspec(spec)
			if err != nil {
				t.Fatalf("%q: unexpected error: %v", spec, err)
			}
			if got.Key != want {
				t.Errorf("%q -> key %q, want %q", spec, got.Key, want)
			}
		}
	})

	t.Run("surrounding and inner whitespace is tolerated", func(t *testing.T) {
		got, err := parseKeyspec("  Ctrl + Shift + K  ")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Mods != hotkeyModControl|hotkeyModShift || got.Key != "k" {
			t.Errorf("got %+v, want ctrl|shift + k", got)
		}
	})

	t.Run("errors name the problem", func(t *testing.T) {
		for _, spec := range []string{"", "   ", "ctrl+", "+", "ctrl++"} {
			if _, err := parseKeyspec(spec); err == nil {
				t.Errorf("parseKeyspec(%q) should report that no key was named", spec)
			}
		}
		if _, err := parseKeyspec("hyper+a"); err == nil {
			t.Error(`parseKeyspec("hyper+a") should reject the unknown modifier`)
		} else if !strings.Contains(err.Error(), "hyper") {
			t.Errorf("error should name the offending modifier, got %q", err)
		}
		// "space" read as a modifier: the LAST token is the key, so everything
		// before it must be a modifier name.
		if _, err := parseKeyspec("ctrl+space+k"); err == nil {
			t.Error(`parseKeyspec("ctrl+space+k") should reject "space" as a modifier`)
		}
	})
}

// The exact-match rule, which is the behaviour change #563 asks for and the one
// piece of the macOS monitor that can be tested anywhere. The C block applies
// `(gotFlags & darwinModifierCompareMask) == wantFlags` with both the mask and
// the already-masked wantFlags handed to it from Go, so this function is the
// same decision the monitor makes.
func TestDarwinHotkeyMatches(t *testing.T) {
	// Real NSEvent flag bits that are NOT part of what a user deliberately held.
	const (
		nsCapsLock   = 1 << 16
		nsNumericPad = 1 << 21
		nsHelp       = 1 << 22
		nsFunction   = 1 << 23
		// Device-dependent bits: which PHYSICAL modifier key was used. Real
		// [NSEvent modifierFlags] carries these in the low byte.
		devLeftShift   = 0x00000002
		devLeftControl = 0x00000001
		devLeftCommand = 0x00000008
		devLeftOption  = 0x00000020
	)

	wantMods, wantCode, err := parseDarwinKeyspec("ctrl+shift+space")
	if err != nil {
		t.Fatalf("parseDarwinKeyspec: %v", err)
	}

	cases := []struct {
		name     string
		gotFlags uint
		gotCode  uint16
		want     bool
	}{
		{
			name:     "exactly the bound combination fires",
			gotFlags: nsModControl | nsModShift,
			gotCode:  wantCode,
			want:     true,
		},
		{
			name:     "the real flags carry device-dependent bits and still fire",
			gotFlags: nsModControl | nsModShift | devLeftControl | devLeftShift,
			gotCode:  wantCode,
			want:     true,
		},
		{
			name:     "Caps Lock on does not disable the hotkey",
			gotFlags: nsModControl | nsModShift | nsCapsLock,
			gotCode:  wantCode,
			want:     true,
		},
		// The evasion shapes: (got & want) == want used to fire on all of these.
		{
			name:     "an extra Command does NOT fire (this is Character Viewer territory)",
			gotFlags: nsModControl | nsModShift | nsModCommand | devLeftCommand,
			gotCode:  wantCode,
			want:     false,
		},
		{
			name:     "an extra Option does NOT fire",
			gotFlags: nsModControl | nsModShift | nsModOption | devLeftOption,
			gotCode:  wantCode,
			want:     false,
		},
		{
			name:     "a MISSING modifier does not fire either",
			gotFlags: nsModControl,
			gotCode:  wantCode,
			want:     false,
		},
		{
			name:     "no modifiers at all does not fire",
			gotFlags: 0,
			gotCode:  wantCode,
			want:     false,
		},
		{
			name:     "the right modifiers on the wrong key does not fire",
			gotFlags: nsModControl | nsModShift,
			gotCode:  wantCode + 1,
			want:     false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := darwinHotkeyMatches(tc.gotFlags, tc.gotCode, wantMods, wantCode); got != tc.want {
				t.Errorf("darwinHotkeyMatches(0x%x, %d) = %v, want %v", tc.gotFlags, tc.gotCode, got, tc.want)
			}
		})
	}

	// Why the comparison is masked rather than a literal `got == want`: macOS
	// sets Function on every F-key and arrow, and NumericPad on the arrows too.
	// A literal equality would make these two bindings unpressable, which is
	// the trap in "just change (got & want) == want to got == want".
	t.Run("an F-key binding fires with the Function flag set", func(t *testing.T) {
		mods, code, err := parseDarwinKeyspec("f13")
		if err != nil {
			t.Fatalf("parseDarwinKeyspec: %v", err)
		}
		if !darwinHotkeyMatches(nsFunction, code, mods, code) {
			t.Error("f13 should fire when macOS reports the Function flag")
		}
	})
	t.Run("an arrow binding fires with Function and NumericPad set", func(t *testing.T) {
		mods, code, err := parseDarwinKeyspec("ctrl+shift+up")
		if err != nil {
			t.Fatalf("parseDarwinKeyspec: %v", err)
		}
		flags := uint(nsModControl | nsModShift | nsFunction | nsNumericPad)
		if !darwinHotkeyMatches(flags, code, mods, code) {
			t.Error("ctrl+shift+up should fire when macOS reports Function|NumericPad")
		}
	})
	t.Run("Help is ignored as well", func(t *testing.T) {
		if !darwinHotkeyMatches(nsModControl|nsModShift|nsHelp, wantCode, wantMods, wantCode) {
			t.Error("the Help flag must not affect the comparison")
		}
	})

	t.Run("the compare mask is exactly the four intentional modifiers", func(t *testing.T) {
		if darwinModifierCompareMask != nsModShift|nsModControl|nsModOption|nsModCommand {
			t.Errorf("compare mask = 0x%x, want the four intentional modifiers only", darwinModifierCompareMask)
		}
		for name, bit := range map[string]uint{
			"CapsLock": nsCapsLock, "NumericPad": nsNumericPad,
			"Help": nsHelp, "Function": nsFunction,
		} {
			if darwinModifierCompareMask&bit != 0 {
				t.Errorf("%s must not be part of the comparison", name)
			}
		}
	})

	t.Run("a parsed mask never reaches outside the compare mask", func(t *testing.T) {
		// Otherwise `got & mask == want` could never be true, and the hotkey
		// would be silently dead rather than over-firing.
		for _, spec := range []string{"ctrl+shift+space", "cmd+shift+k", "alt+f13", "f19", "ctrl+alt+shift+cmd+k"} {
			mods, _, err := parseDarwinKeyspec(spec)
			if err != nil {
				t.Fatalf("%q: %v", spec, err)
			}
			if mods&^darwinModifierCompareMask != 0 {
				t.Errorf("%q -> mask 0x%x has bits outside the compare mask", spec, mods)
			}
		}
	})
}

// One key name must mean one key on all three platforms, because ONE default
// pair ships to all three. Before #563 it did not: `ctrl+left` and `ctrl+f13`
// resolved on Windows and were refused on Linux and macOS, `ctrl+tab` was
// refused on Linux, and `command+k` was refused on Linux.
func TestKeyNameParityAcrossBackends(t *testing.T) {
	// linuxKeysymName cannot be checked against XStringToKeysym here (that
	// needs cgo + XLib, so hotkeys_linux_test.go does it on Linux). What is
	// checked here is that every key the other two resolve is RECOGNISED --
	// either in the keysym table or a computed F<n> -- and not falling through
	// the passthrough branch. A plain non-empty check would be tautological
	// (linuxKeysymName never returns "" for a non-empty key), and deleting the
	// `"tab": "Tab"` row would still pass it while breaking ctrl+tab on Linux,
	// which is the exact regression #563 is about.
	keys := []string{
		"a", "k", "z", "0", "9",
		"space", "return", "tab", "escape", "backspace", "delete",
		"home", "end", "pageup", "pagedown",
		"left", "right", "up", "down",
		"minus", "equal", "leftbracket", "rightbracket", "backslash",
		"semicolon", "quote", "comma", "period", "slash", "grave",
	}
	for i := 1; i <= 20; i++ {
		keys = append(keys, fmt.Sprintf("f%d", i))
	}
	for _, key := range keys {
		if _, ok := darwinKeyCode(key); !ok {
			t.Errorf("key %q has no macOS key code", key)
		}
		if _, ok := windowsVK(key); !ok {
			t.Errorf("key %q has no Windows virtual-key code", key)
		}
		if !linuxKeysymRecognised(key) {
			t.Errorf("key %q falls through to the XStringToKeysym passthrough; it needs a linuxKeysymNames row", key)
		}
	}

	// The one documented exception, stated as a rule so it cannot rot into a
	// silent mismatch: macOS has no Insert key. The position a PC labels Insert
	// is Help on an Apple Extended Keyboard and absent from every other Apple
	// keyboard, so `insert` is refused on macOS rather than aimed at a key the
	// user does not have.
	if _, ok := darwinKeyCode("insert"); ok {
		t.Error("macOS should not claim to have an Insert key")
	}
	if _, ok := windowsVK("insert"); !ok {
		t.Error("Windows does have an Insert key")
	}

	t.Run("the shipped defaults resolve on all three backends", func(t *testing.T) {
		// Whatever the shipped defaults are, they must parse everywhere.
		//
		// KEEP IN SYNC WITH PEBBLE_DEFAULT_SUMMON_HOTKEY and
		// PEBBLE_DEFAULT_PALETTE_HOTKEY in src/config/pebble-hotkeys.ts, which
		// is the one place the shipped pair is decided. This copy and the one
		// in hotkeys_linux_test.go exist because the Go side cannot import a
		// TypeScript constant; grep for PEBBLE_DEFAULT_ to find them all.
		for _, spec := range []string{"ctrl+shift+space", "ctrl+shift+k"} {
			if _, _, err := parseDarwinKeyspec(spec); err != nil {
				t.Errorf("macOS cannot parse the default %q: %v", spec, err)
			}
			if _, _, err := parseHotkey(spec); err != nil {
				t.Errorf("Windows cannot parse the default %q: %v", spec, err)
			}
			parsed, err := parseKeyspec(spec)
			if err != nil {
				t.Errorf("shared parse of the default %q failed: %v", spec, err)
				continue
			}
			if !linuxKeysymRecognised(parsed.Key) {
				t.Errorf("Linux has no keysym row for the default %q", spec)
			}
		}
	})

	t.Run("specs that used to resolve on only one backend now resolve on all", func(t *testing.T) {
		for _, spec := range []string{"ctrl+left", "ctrl+f13", "ctrl+tab", "command+k", "ctrl+shift+f19", "alt+down"} {
			if _, _, err := parseDarwinKeyspec(spec); err != nil {
				t.Errorf("macOS: %q: %v", spec, err)
			}
			if _, _, err := parseHotkey(spec); err != nil {
				t.Errorf("Windows: %q: %v", spec, err)
			}
		}
	})
}

// The key codes are hand-transcribed from HIToolbox/Events.h and cannot be
// verified by compiling anything here, so the ones that matter are pinned by
// value. A typo in this table is a hotkey that fires on the wrong physical key.
func TestDarwinKeyCodeValues(t *testing.T) {
	for key, want := range map[string]uint16{
		"a": 0, "s": 1, "k": 40, "q": 12, "z": 6, // kVK_ANSI_*
		"1": 18, "0": 29,
		"space": 49, "return": 36, "tab": 48, "escape": 53, "backspace": 51,
		"delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
		"left": 123, "right": 124, "down": 125, "up": 126,
		"minus": 27, "equal": 24, "grave": 50, "slash": 44,
		"f1": 122, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
		"f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
	} {
		got, ok := darwinKeyCode(key)
		if !ok {
			t.Errorf("no macOS key code for %q", key)
			continue
		}
		if got != want {
			t.Errorf("macOS key code for %q = %d, want %d", key, got, want)
		}
	}

	t.Run("no two names share a key code", func(t *testing.T) {
		seen := map[uint16]string{}
		for name, code := range darwinKeyCodes {
			if other, dup := seen[code]; dup {
				t.Errorf("key code %d is claimed by both %q and %q", code, other, name)
			}
			seen[code] = name
		}
	})

	// The layout question, pinned as a fact rather than left as a comment:
	// these are PHYSICAL US-ANSI positions, not characters. On AZERTY the key
	// labelled `a` is at the position this table calls `q`. Windows and X11
	// resolve a name through the active layout instead, so the same spec can
	// address a different physical key on macOS than on the other two.
	// docs/PEBBLE_HOTKEYS.md says so; this makes sure it stays true.
	t.Run("names are US-ANSI physical positions", func(t *testing.T) {
		if code, _ := darwinKeyCode("q"); code != 12 {
			t.Errorf("q should be kVK_ANSI_Q (12), the position AZERTY labels 'a'; got %d", code)
		}
		if code, _ := darwinKeyCode("a"); code != 0 {
			t.Errorf("a should be kVK_ANSI_A (0), the position AZERTY labels 'q'; got %d", code)
		}
	})
}

// A regression guard for the move out of hotkeys_windows.go: the Windows
// backend's own test is //go:build windows, so this is the only place the
// virtual-key table is exercised in a Linux CI job.
func TestWindowsVKValues(t *testing.T) {
	for key, want := range map[string]uint32{
		"a": 0x41, "z": 0x5A, "0": 0x30, "9": 0x39,
		"space": 0x20, "return": 0x0D, "tab": 0x09, "escape": 0x1B,
		"backspace": 0x08, "delete": 0x2E, "insert": 0x2D,
		"home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
		"left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
		"f1": 0x70, "f12": 0x7B, "f13": 0x7C, "f24": 0x87,
		"minus": 0xBD, "equal": 0xBB, "semicolon": 0xBA, "grave": 0xC0,
	} {
		got, ok := windowsVK(key)
		if !ok {
			t.Errorf("no Windows VK for %q", key)
			continue
		}
		if got != want {
			t.Errorf("Windows VK for %q = 0x%X, want 0x%X", key, got, want)
		}
	}

	t.Run("a bare f is the letter, not a function key", func(t *testing.T) {
		if got, _ := windowsVK("f"); got != 0x46 {
			t.Errorf("windowsVK(\"f\") = 0x%X, want VK_F 0x46", got)
		}
	})
	t.Run("f0 and f25 are not keys", func(t *testing.T) {
		for _, name := range []string{"f0", "f25", "f99", "fx"} {
			if _, ok := windowsVK(name); ok {
				t.Errorf("windowsVK(%q) should not resolve", name)
			}
		}
	})
	t.Run("parseHotkey produces MOD_ flags", func(t *testing.T) {
		mods, vk, err := parseHotkey("ctrl+shift+space")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if mods != modControl|modShift {
			t.Errorf("mods = 0x%X, want MOD_CONTROL|MOD_SHIFT", mods)
		}
		if vk != 0x20 {
			t.Errorf("vk = 0x%X, want VK_SPACE", vk)
		}
	})
	t.Run("win, cmd and super all mean MOD_WIN", func(t *testing.T) {
		for _, name := range []string{"win", "cmd", "command", "super", "meta"} {
			mods, _, err := parseHotkey(name + "+k")
			if err != nil {
				t.Fatalf("%q: %v", name, err)
			}
			if mods != modWin {
				t.Errorf("%q -> 0x%X, want MOD_WIN", name, mods)
			}
		}
	})
}

func TestLinuxKeysymNames(t *testing.T) {
	// The case-sensitivity trap: XStringToKeysym("tab") and ("f13") are
	// NoSymbol, which is exactly why `ctrl+tab` and `ctrl+f13` used to be
	// refused on Linux alone. hotkeys_linux_test.go checks these resolve against
	// the real XStringToKeysym; here the SPELLING is pinned.
	for key, want := range map[string]string{
		"tab": "Tab", "return": "Return", "escape": "Escape",
		"backspace": "BackSpace", "delete": "Delete", "insert": "Insert",
		"pageup": "Prior", "pagedown": "Next",
		"left": "Left", "right": "Right", "up": "Up", "down": "Down",
		"leftbracket": "bracketleft", "rightbracket": "bracketright",
		"quote": "apostrophe", "space": "space",
		"f1": "F1", "f13": "F13", "f20": "F20",
	} {
		if got := linuxKeysymName(key); got != want {
			t.Errorf("linuxKeysymName(%q) = %q, want %q", key, got, want)
		}
	}

	t.Run("unknown names pass through for XStringToKeysym", func(t *testing.T) {
		// Linux accepted any lowercase keysym name before #563 ("ctrl+yen"),
		// and must keep doing so: narrowing this would break configs that work.
		for _, key := range []string{"a", "7", "yen", "mu", "sterling"} {
			if got := linuxKeysymName(key); got != key {
				t.Errorf("linuxKeysymName(%q) = %q, want it passed through", key, got)
			}
		}
	})
}

// linuxKeysymRecognised reports whether linuxKeysymName resolved the key from
// its table (or the computed F<n> branch) rather than passing it through
// untouched. A passthrough is only correct for names that are already X keysym
// names; for a key the other two backends know, it means a missing row.
func linuxKeysymRecognised(key string) bool {
	if _, ok := linuxKeysymNames[key]; ok {
		return true
	}
	name := linuxKeysymName(key)
	if name != key {
		return true // computed, e.g. "f13" -> "F13"
	}
	// Unchanged: correct only where the canonical name IS the keysym name,
	// which is true for the single-character letters and digits.
	return len(key) == 1 && ((key[0] >= 'a' && key[0] <= 'z') || (key[0] >= '0' && key[0] <= '9'))
}

// The modifier tables are hand-transcribed from three OS headers and, unlike
// the key codes, every other assertion about them is written in terms of the
// constants themselves (`mods != modControl|modShift`), so swapping two values
// would pass the whole suite and ship a hotkey registered on the wrong
// modifier. Pinned by literal value here, the same way the NSEvent bits are.
func TestModifierTableValues(t *testing.T) {
	t.Run("Win32 MOD_ flags", func(t *testing.T) {
		for name, got := range map[string]uint32{"MOD_ALT": modAlt, "MOD_CONTROL": modControl, "MOD_SHIFT": modShift, "MOD_WIN": modWin} {
			want := map[string]uint32{"MOD_ALT": 0x0001, "MOD_CONTROL": 0x0002, "MOD_SHIFT": 0x0004, "MOD_WIN": 0x0008}[name]
			if got != want {
				t.Errorf("%s = 0x%X, want 0x%X", name, got, want)
			}
		}
		if windowsModifierMask(hotkeyModControl|hotkeyModShift) != 0x0006 {
			t.Error("ctrl|shift should be MOD_CONTROL|MOD_SHIFT = 0x0006")
		}
		if windowsModifierMask(hotkeyModOption) != 0x0001 {
			t.Error("alt/option must map to MOD_ALT, not MOD_WIN")
		}
		if windowsModifierMask(hotkeyModCommand) != 0x0008 {
			t.Error("cmd/super/win must map to MOD_WIN")
		}
	})

	t.Run("X11 modifier masks", func(t *testing.T) {
		for name, pair := range map[string][2]uint{
			"ShiftMask": {hkShiftMask, 1 << 0}, "ControlMask": {hkControlMask, 1 << 2},
			"Mod1Mask": {hkMod1Mask, 1 << 3}, "Mod4Mask": {hkMod4Mask, 1 << 6},
		} {
			if pair[0] != pair[1] {
				t.Errorf("%s = %d, want %d", name, pair[0], pair[1])
			}
		}
		if linuxModifierMask(hotkeyModControl|hotkeyModShift) != 5 {
			t.Error("ctrl|shift should be ControlMask|ShiftMask = 5")
		}
		if linuxModifierMask(hotkeyModOption) != 8 {
			t.Error("alt/option must map to Mod1Mask")
		}
		if linuxModifierMask(hotkeyModCommand) != 0x40 {
			t.Error("cmd/super/win must map to Mod4Mask")
		}
	})

	t.Run("NSEventModifierFlags", func(t *testing.T) {
		for name, pair := range map[string][2]uint{
			"Shift": {nsModShift, 1 << 17}, "Control": {nsModControl, 1 << 18},
			"Option": {nsModOption, 1 << 19}, "Command": {nsModCommand, 1 << 20},
		} {
			if pair[0] != pair[1] {
				t.Errorf("NSEventModifierFlag%s = 0x%X, want 0x%X", name, pair[0], pair[1])
			}
		}
		if darwinModifierMask(hotkeyModControl|hotkeyModShift) != nsModControl|nsModShift {
			t.Error("ctrl|shift should be Control|Shift")
		}
		if darwinModifierMask(hotkeyModOption) != nsModOption {
			t.Error("alt/option must map to Option, not Command")
		}
	})
}

// The key codes a transcription error is most likely to hit: pairs that read
// backwards or out of order in the source tables. Separate from
// TestDarwinKeyCodeValues so the reason they are listed is on the record.
func TestTranspositionProneKeyCodes(t *testing.T) {
	t.Run("macOS digits 5 and 6 are inverted in Events.h", func(t *testing.T) {
		// kVK_ANSI_5 = 0x17 (23), kVK_ANSI_6 = 0x16 (22). Not a typo.
		if c, _ := darwinKeyCode("5"); c != 23 {
			t.Errorf("5 = %d, want kVK_ANSI_5 23", c)
		}
		if c, _ := darwinKeyCode("6"); c != 22 {
			t.Errorf("6 = %d, want kVK_ANSI_6 22", c)
		}
	})
	t.Run("macOS h and g are inverted too", func(t *testing.T) {
		if c, _ := darwinKeyCode("h"); c != 4 {
			t.Errorf("h = %d, want 4", c)
		}
		if c, _ := darwinKeyCode("g"); c != 5 {
			t.Errorf("g = %d, want 5", c)
		}
	})
	t.Run("macOS brackets read backwards", func(t *testing.T) {
		// kVK_ANSI_RightBracket (30) is LOWER than kVK_ANSI_LeftBracket (33).
		if c, _ := darwinKeyCode("leftbracket"); c != 33 {
			t.Errorf("leftbracket = %d, want 33", c)
		}
		if c, _ := darwinKeyCode("rightbracket"); c != 30 {
			t.Errorf("rightbracket = %d, want 30", c)
		}
	})
	t.Run("macOS remaining punctuation", func(t *testing.T) {
		for key, want := range map[string]uint16{
			"backslash": 42, "semicolon": 41, "quote": 39, "comma": 43, "period": 47,
		} {
			if c, _ := darwinKeyCode(key); c != want {
				t.Errorf("%s = %d, want %d", key, c, want)
			}
		}
	})
	t.Run("Windows OEM punctuation", func(t *testing.T) {
		for key, want := range map[string]uint32{
			"leftbracket": 0xDB, "rightbracket": 0xDD, "backslash": 0xDC,
			"quote": 0xDE, "comma": 0xBC, "period": 0xBE, "slash": 0xBF,
		} {
			if vk, _ := windowsVK(key); vk != want {
				t.Errorf("%s = 0x%X, want 0x%X", key, vk, want)
			}
		}
	})
}
