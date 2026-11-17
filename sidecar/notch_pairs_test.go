package main

// The notch's own settings change the two pairs of keys (notch.keys). What a
// change may be is decided here, apart from any keyboard.

import (
	"fmt"
	"testing"
)

func TestNotchPairsWantedKeepsWhatIsNotNamedAndRefusesTheSameTwoKeys(t *testing.T) {
	now := notchDefaultPairs("windows")
	// Only talk is named: yes stays.
	got, err := notchPairsWanted(now, "ctrl+alt", "")
	if err != nil || got.Talk.String() != "ctrl+alt" || got.Yes != now.Yes {
		t.Fatalf("talk alone: got %v %v, err %v", got.Talk, got.Yes, err)
	}
	// Only yes is named: talk stays.
	got, err = notchPairsWanted(now, "", "alt+shift")
	if err != nil || got.Talk != now.Talk || got.Yes.String() != "alt+shift" {
		t.Fatalf("yes alone: got %v %v, err %v", got.Talk, got.Yes, err)
	}
	// The same two keys for both, in either order, is refused and nothing changes.
	for _, same := range []string{"meta+alt", "alt+meta"} {
		got, err = notchPairsWanted(now, same, "")
		if err == nil || got != now {
			t.Fatalf("talk %q with yes %v must be refused and leave the pairs alone, got %v, err %v", same, now.Yes, got, err)
		}
	}
	// Nonsense is refused and nothing changes.
	for _, bad := range []string{"ctrl", "ctrl+ctrl", "ctrl+k", "a+b+c"} {
		if got, err = notchPairsWanted(now, bad, ""); err == nil || got != now {
			t.Fatalf("%q must be refused, got %v, err %v", bad, got, err)
		}
	}
}

func TestNotchPairsAnswerNamesTheKeysAndTheMac(t *testing.T) {
	win := notchPairsAnswer(notchDefaultPairs("windows"), "windows")
	if fmt.Sprint(win["talk"]) != "[ctrl meta]" || fmt.Sprint(win["yes"]) != "[meta alt]" || win["mac"] != false {
		t.Fatalf("windows: %v", win)
	}
	mac := notchPairsAnswer(notchDefaultPairs("darwin"), "darwin")
	if fmt.Sprint(mac["talk"]) != "[ctrl alt]" || fmt.Sprint(mac["yes"]) != "[alt meta]" || mac["mac"] != true {
		t.Fatalf("mac: %v", mac)
	}
}
