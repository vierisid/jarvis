//go:build linux

package main

import "testing"

// parseLinuxKeyspec is pure Go for modifier/alias parsing; the final keysym
// lookup goes through XStringToKeysym, which is a client-side table lookup and
// needs no X display, so this runs headless in CI.
func TestParseLinuxKeyspec(t *testing.T) {
	t.Run("modifiers combine", func(t *testing.T) {
		mods, ks, err := parseLinuxKeyspec("ctrl+shift+a")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if mods != hkControlMask|hkShiftMask {
			t.Errorf("mods = %d, want ctrl|shift", mods)
		}
		if ks == 0 {
			t.Errorf("keysym for 'a' should be non-zero")
		}
	})

	t.Run("modifier aliases", func(t *testing.T) {
		mods, _, err := parseLinuxKeyspec("control+option+super+space")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := uint(hkControlMask | hkMod1Mask | hkMod4Mask)
		if mods != want {
			t.Errorf("mods = %d, want %d", mods, want)
		}
	})

	t.Run("key aliases resolve to a keysym", func(t *testing.T) {
		// Note: a literal " " can't be a trailing token (TrimSpace strips it
		// before the split), so only the named aliases are reachable here.
		for _, k := range []string{"space", "spacebar", "esc", "escape", "enter", "return"} {
			if _, ks, err := parseLinuxKeyspec("ctrl+" + k); err != nil || ks == 0 {
				t.Errorf("alias %q: ks=%d err=%v", k, ks, err)
			}
		}
	})

	t.Run("errors", func(t *testing.T) {
		for _, spec := range []string{"", "   ", "ctrl+", "hyper+a", "ctrl+notarealkey123"} {
			if _, _, err := parseLinuxKeyspec(spec); err == nil {
				t.Errorf("parseLinuxKeyspec(%q) should error", spec)
			}
		}
	})
}

// Every key name the shared layer knows must resolve to a real KeySym, proven
// against the actual XStringToKeysym rather than against our own table. This is
// the Linux half of the parity check in hotkeys_keyspec_test.go, and it is why
// the keysym spellings are a table: XStringToKeysym is case-sensitive, so "tab",
// "f13", "left" and "pageup" are all NoSymbol, which is how `ctrl+tab` and
// `ctrl+f13` came to parse on Windows and fail on Linux alone (#563).
func TestLinuxKeyNameParity(t *testing.T) {
	keys := []string{
		"a", "k", "z", "0", "9",
		"space", "spacebar", "return", "enter", "tab", "escape", "esc",
		"backspace", "delete", "del", "insert", "ins",
		"home", "end", "pageup", "pgup", "pagedown", "pgdn",
		"left", "right", "up", "down",
		"minus", "equal", "leftbracket", "rightbracket", "backslash",
		"semicolon", "quote", "comma", "period", "slash", "grave",
		"-", "=", "[", "]", ";", "'", ",", ".", "/", "`",
		"f1", "f5", "f12", "f13", "f19", "f20",
	}
	for _, key := range keys {
		mods, ks, err := parseLinuxKeyspec("ctrl+shift+" + key)
		if err != nil {
			t.Errorf("ctrl+shift+%s: %v", key, err)
			continue
		}
		if ks == 0 {
			t.Errorf("ctrl+shift+%s resolved to NoSymbol", key)
		}
		if mods != hkControlMask|hkShiftMask {
			t.Errorf("ctrl+shift+%s: mods = %d, want ctrl|shift", key, mods)
		}
	}
}

// The shipped defaults, resolved through the real X keysym table.
//
// KEEP IN SYNC WITH PEBBLE_DEFAULT_SUMMON_HOTKEY and PEBBLE_DEFAULT_PALETTE_HOTKEY
// in src/config/pebble-hotkeys.ts -- grep PEBBLE_DEFAULT_ for every copy.
func TestLinuxResolvesTheShippedDefaults(t *testing.T) {
	for _, spec := range []string{"ctrl+shift+space", "ctrl+shift+k"} {
		mods, ks, err := parseLinuxKeyspec(spec)
		if err != nil {
			t.Fatalf("%q: %v", spec, err)
		}
		if ks == 0 {
			t.Errorf("%q resolved to NoSymbol", spec)
		}
		if mods != hkControlMask|hkShiftMask {
			t.Errorf("%q: mods = %d, want ctrl|shift", spec, mods)
		}
	}
}

// "command" was the one modifier spelling Linux refused while macOS and Windows
// accepted it.
func TestLinuxAcceptsEveryModifierSpelling(t *testing.T) {
	for _, group := range [][]string{
		{"ctrl", "control"},
		{"alt", "opt", "option"},
		{"cmd", "command", "super", "win", "meta"},
	} {
		var first uint
		for i, name := range group {
			mods, _, err := parseLinuxKeyspec(name + "+k")
			if err != nil {
				t.Fatalf("%q: %v", name, err)
			}
			if i == 0 {
				first = mods
				continue
			}
			if mods != first {
				t.Errorf("modifier %q = %d, want %d (same as %q)", name, mods, first, group[0])
			}
		}
	}
}
