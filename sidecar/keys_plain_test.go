package main

import "testing"

func TestALetterOrDigitOfAShortcutIsItsOwnKey(t *testing.T) {
	for name, want := range map[string]uint16{"c": 0x43, "C": 0x43, "v": 0x56, "a": 0x41, "z": 0x5A, "0": 0x30, "1": 0x31, "9": 0x39} {
		if got, ok := plainKeyVk(name); !ok || got != want {
			t.Errorf("plainKeyVk(%q) = %#x, %v; want %#x", name, got, ok, want)
		}
	}
	// Anything else is asked of the layout, as before.
	for _, name := range []string{"", "?", "/", "enter", "f5", "é", "ab", "-"} {
		if _, ok := plainKeyVk(name); ok {
			t.Errorf("plainKeyVk(%q) should not be a plain key", name)
		}
	}
	if !shortcutMods["ctrl"] || !shortcutMods["alt"] || !shortcutMods["win"] || shortcutMods["shift"] {
		t.Error("Ctrl, Alt and Win make a shortcut; Shift alone does not")
	}
}

func TestAPressGoesOnlyWhereThePointerWasPut(t *testing.T) {
	if !notchPressOnPlace(500, 300, 500, 300) || !notchPressOnPlace(502, 298, 500, 300) {
		t.Error("on the place, or a rounding away from it, is on the place")
	}
	if notchPressOnPlace(503, 300, 500, 300) || notchPressOnPlace(500, 340, 500, 300) {
		t.Error("moved away is not on the place")
	}
}
