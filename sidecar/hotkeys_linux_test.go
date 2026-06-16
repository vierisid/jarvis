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
