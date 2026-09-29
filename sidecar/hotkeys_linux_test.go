//go:build linux

package main

import (
	"strings"
	"testing"
)

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

// A grab the X server refuses has to come back as an ERROR (#574).
//
// It used to come back as success: the error handler swallowed BadAccess and
// jarvisHotkeyCreate returned a Hotkey either way, so the caller logged
// `summon hotkey "ctrl+shift+space" registered` for a combination another
// client held and the key did nothing for the rest of the session -- the one
// message guaranteed to send whoever is debugging a dead hotkey looking
// somewhere else. This is the Linux counterpart of
// TestHotkeysRefusedRegistrationIsReported in hotkeys_windows_test.go, and it
// reproduces the clash the same way: hold one, then ask for it again.
//
// Two X clients are involved, not one -- each listener opens its own display
// connection -- which is exactly what makes the server refuse the second.
//
// Skips where there is no X server, so headless CI skips it and a developer
// with a desktop (or anything reaching an X server, including WSLg) gets the
// real round trip. That is deliberate: the grab lives in the cgo half and this
// is the only place it can be exercised at all.
func TestLinuxRefusedGrabIsReported(t *testing.T) {
	// Deliberately obscure: this really does grab the combination on the
	// running desktop for the length of the test, so it must not be one
	// anybody has bound. Four modifiers plus a letter is not a shipped
	// default and is not a stock binding in any desktop environment.
	const spec = "ctrl+alt+shift+super+k"

	held, err := startHotkeyListener(spec, func() {})
	if err != nil {
		t.Skipf("this environment cannot grab global hotkeys at all: %v", err)
	}
	if held == nil {
		t.Fatal("a successful grab returned a nil stop function")
	}
	defer held()

	second, err := startHotkeyListener(spec, func() {})
	if err == nil {
		if second != nil {
			second()
		}
		// Not a flake to skip past: X refuses a passive grab that another
		// client already holds, so success here means the refusal is being
		// swallowed again and #574 has regressed.
		t.Fatal("a second grab of a combination already held came back as SUCCESS; a refused XGrabKey is being reported as registered again (#574)")
	}
	if second != nil {
		t.Fatal("a refused grab handed back a stop function; every caller reads a non-nil stop as a live hotkey")
	}
	if !strings.Contains(err.Error(), spec) {
		t.Errorf("the error should name the hotkey that failed, got: %v", err)
	}
	if !strings.Contains(err.Error(), "already held") {
		t.Errorf("a BadAccess refusal should be reported as the combination being held, got: %v", err)
	}
	// Logged, not just asserted: this is the line a user will see in the
	// sidecar log, and it is worth being able to read it in test output
	// alongside the Windows one it is meant to match.
	t.Logf("refusal reported as: %v", err)
}

// Releasing a hotkey has to release the X grab, or the combination stays dead
// for everybody after the sidecar has stopped listening for it.
//
// This is also the regression guard for the failure path's cleanup: a refused
// create ungrabs the variants it was granted before giving up. The stronger
// form of that proof -- a third client taking a lock variant while a squatter
// still holds the base one -- needs a raw X client and was done in C against a
// real server rather than from here; see the comment on startHotkeyListener.
func TestLinuxGrabIsReleasedOnStop(t *testing.T) {
	const spec = "ctrl+alt+shift+super+j"

	first, err := startHotkeyListener(spec, func() {})
	if err != nil {
		t.Skipf("this environment cannot grab global hotkeys at all: %v", err)
	}
	first()

	second, err := startHotkeyListener(spec, func() {})
	if err != nil {
		t.Fatalf("the combination was still held after stop(); the grab leaked: %v", err)
	}
	second()
}
