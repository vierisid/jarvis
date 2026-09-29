//go:build linux

package main

import (
	"os"
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
		// Either there is no X display, or something already holds this
		// combination. Both mean there is no first grab to contend with.
		t.Skipf("cannot grab %q here: %v", spec, err)
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
	// Derived from the pid so two concurrent runs of this package against one X
	// server do not hold the same combination and blame each other. This repo
	// hits that class of phantom failure routinely when worktrees test in
	// parallel, and the whole point of this test is to distinguish "we leaked a
	// grab" from "somebody else holds it" -- which it cannot do if the somebody
	// else is another copy of itself.
	keys := []string{"j", "m", "n", "b", "y", "u", "i", "o"}
	spec := "ctrl+alt+shift+super+" + keys[os.Getpid()%len(keys)]

	first, err := startHotkeyListener(spec, func() {})
	if err != nil {
		// Includes the case where something else already holds it, which is not
		// this test's subject.
		t.Skipf("cannot grab %q here: %v", spec, err)
	}
	first()

	second, err := startHotkeyListener(spec, func() {})
	if err != nil {
		t.Fatalf("%q could not be grabbed again after stop(); the first grab was not released: %v", spec, err)
	}
	second()
}

// The partial clash is the case the all-or-nothing decision exists for, so it
// gets a real X round trip rather than a claim in a comment.
//
// A squatter takes ONE modifier variant (the plain one). The combination is then
// neither free nor fully taken, which is exactly the state that used to produce
// a hotkey working only in some lock states. startHotkeyListener must refuse the
// whole thing, name the variant that clashed, and leave nothing grabbed.
func TestLinuxPartialClashIsRefusedWholesale(t *testing.T) {
	const spec = "ctrl+alt+shift+super+p"

	// Variant 0 is the plain modifier mask; the lock variants stay free.
	releaseSquatter, ok := hotkeyHoldOneVariant(spec, 0)
	if !ok {
		t.Skipf("could not hold one variant of %q (no display, or something already holds it)", spec)
	}
	defer releaseSquatter()

	stop, err := startHotkeyListener(spec, func() {})
	if err == nil {
		if stop != nil {
			stop()
		}
		t.Fatal("a combination whose plain variant is held came back as SUCCESS; a partial grab was kept, which is a hotkey that works only in some lock states")
	}
	if stop != nil {
		t.Fatal("a refused grab handed back a stop function; callers read a non-nil stop as a live hotkey")
	}
	if !strings.Contains(err.Error(), "plain") {
		t.Errorf("the message should name the variant that clashed, got: %v", err)
	}
	if !strings.Contains(err.Error(), "refused as a whole") {
		t.Errorf("the message should say the whole grab was refused, got: %v", err)
	}
	t.Logf("partial clash reported as: %v", err)

	// The lock variants the refused create was granted must have been released:
	// if they were not, this second single-variant grab would be refused. This
	// is the cleanup proof that XCloseDisplay alone would also have provided,
	// asserted rather than assumed.
	releaseProbe, ok := hotkeyHoldOneVariant(spec, 1) // LockMask
	if !ok {
		t.Fatal("the CapsLock variant is still held; a refused create left part of the combination grabbed")
	}
	releaseProbe()
}
