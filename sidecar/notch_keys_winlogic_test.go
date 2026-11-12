package main

import (
	"reflect"
	"testing"
	"time"
)

type notchFed struct {
	Kind notchKeyKind
	Mods notchMods
}

// notchWinRig is the hook's logic with a stand-in for Windows: what it fed on
// is written down, and which keys Windows "has down" is set by the test.
type notchWinRig struct {
	w       notchWinWatch
	fed     []notchFed
	keep    bool
	heldNow map[uint32]bool
}

func newNotchWinRig() *notchWinRig {
	r := &notchWinRig{heldNow: map[uint32]bool{}}
	r.w.feed = func(kind notchKeyKind, mods notchMods) bool {
		r.fed = append(r.fed, notchFed{kind, mods})
		return r.keep
	}
	r.w.held = func(vk uint32) bool { return r.heldNow[vk] }
	return r
}

func (r *notchWinRig) down(vk uint32) bool {
	kept := r.w.see(notchWinKey{Vk: vk, Down: true})
	r.heldNow[vk] = true
	return kept
}

func (r *notchWinRig) up(vk uint32) bool {
	kept := r.w.see(notchWinKey{Vk: vk, Down: false})
	r.heldNow[vk] = false
	return kept
}

// The rule the hook must keep: a key is Esc, a modifier, or "another key", and
// which other key is passed on to nobody. Two different letters are the same
// thing to everything after the hook.
func TestNotchWinKeysEveryOtherKeyIsTheSameKey(t *testing.T) {
	a, b := newNotchWinRig(), newNotchWinRig()
	for _, vk := range []uint32{0x41, 0x30, 0x20, 0x0D, 0x70, 0xBA} { // A, 0, space, enter, F1, a punctuation key
		a.down(vk)
		a.up(vk)
	}
	for _, vk := range []uint32{0x5A, 0x39, 0x09, 0x08, 0x7B, 0xBF} { // Z, 9, tab, backspace, F12, another
		b.down(vk)
		b.up(vk)
	}
	if !reflect.DeepEqual(a.fed, b.fed) {
		t.Fatalf("different keys were told apart:\n%v\n%v", a.fed, b.fed)
	}
	for _, f := range a.fed {
		if f != (notchFed{notchKeyOther, 0}) {
			t.Fatalf("a plain key was fed on as %+v", f)
		}
	}
	// A press is told; a release of an ordinary key is not.
	if len(a.fed) != 6 {
		t.Fatalf("six presses should be six events, got %d", len(a.fed))
	}
}

func TestNotchWinKeysLeftAndRightAreTheSameModifier(t *testing.T) {
	for name, c := range map[string]struct {
		vk   uint32
		want notchMods
	}{
		"left ctrl": {notchVkLControl, notchModCtrl}, "right ctrl": {notchVkRControl, notchModCtrl},
		"left alt": {notchVkLMenu, notchModAlt}, "right alt": {notchVkRMenu, notchModAlt},
		"left win": {notchVkLWin, notchModMeta}, "right win": {notchVkRWin, notchModMeta},
		"left shift": {notchVkLShift, notchModShift}, "right shift": {notchVkRShift, notchModShift},
	} {
		r := newNotchWinRig()
		r.down(c.vk)
		r.up(c.vk)
		want := []notchFed{{notchKeyModifiers, c.want}, {notchKeyModifiers, 0}}
		if !reflect.DeepEqual(r.fed, want) {
			t.Errorf("%s: fed %v", name, r.fed)
		}
	}
}

// A held key repeats. To the engine nothing changed.
func TestNotchWinKeysAHeldModifierIsToldOnce(t *testing.T) {
	r := newNotchWinRig()
	for i := 0; i < 5; i++ {
		r.down(notchVkLWin)
	}
	r.up(notchVkLWin)
	if len(r.fed) != 2 {
		t.Fatalf("five repeats and a release should be two events, got %v", r.fed)
	}
}

// AltGr types letters: it must never count as Ctrl, as Alt, or as both.
func TestNotchWinKeysAltGrIsNeitherCtrlNorAlt(t *testing.T) {
	r := newNotchWinRig()
	// What Windows sends for AltGr: a left Ctrl nobody pressed, with its own
	// scan code, then the right Alt.
	if r.w.see(notchWinKey{Vk: notchVkLControl, Scan: notchScanAltGrCtrl, Down: true}) {
		t.Fatal("the Ctrl that comes with AltGr was kept from the app")
	}
	r.heldNow[notchVkLControl] = true
	r.down(notchVkRMenu)
	r.down(0x45) // E, for the euro sign
	r.up(0x45)
	r.up(notchVkRMenu)
	r.w.see(notchWinKey{Vk: notchVkLControl, Scan: notchScanAltGrCtrl, Down: false})
	r.heldNow[notchVkLControl] = false
	want := []notchFed{{notchKeyOther, 0}, {notchKeyOther, 0}}
	if !reflect.DeepEqual(r.fed, want) {
		t.Fatalf("AltGr + E was fed on as %v, want two plain keys", r.fed)
	}
	if !r.w.idle() {
		t.Fatal("after AltGr came up, something is still thought to be down")
	}
	// With the Windows key as well it is still not the talk pair.
	r.fed = nil
	r.w.see(notchWinKey{Vk: notchVkLControl, Scan: notchScanAltGrCtrl, Down: true})
	r.heldNow[notchVkLControl] = true
	r.down(notchVkRMenu)
	r.down(notchVkLWin)
	if got := r.fed[len(r.fed)-1]; got != (notchFed{notchKeyModifiers, notchModMeta}) {
		t.Fatalf("AltGr + Win was fed on as %+v, want the Windows key alone", got)
	}
}

// A real left Ctrl with the right Alt, on a layout without AltGr, is Ctrl + Alt.
func TestNotchWinKeysARealCtrlWithRightAltIsCtrlAndAlt(t *testing.T) {
	r := newNotchWinRig()
	r.down(notchVkLControl)
	r.down(notchVkRMenu)
	if got := r.fed[len(r.fed)-1]; got != (notchFed{notchKeyModifiers, notchModCtrl | notchModAlt}) {
		t.Fatalf("fed %+v", got)
	}
}

// Only a person talks to the notch. Jarvis itself types and presses keys in
// other apps, and so do other programs: none of it is a key a person pressed.
func TestNotchWinKeysAKeyAProgramSentIsNotAKey(t *testing.T) {
	r := newNotchWinRig()
	r.keep = true
	injected := func(vk uint32, extra uintptr, down bool) bool {
		return r.w.see(notchWinKey{Vk: vk, Flags: notchLlkhfInjected, Extra: extra, Down: down})
	}
	// Our own harmless key.
	injected(notchVkMask, notchKeyTag, true)
	injected(notchVkMask, notchKeyTag, false)
	// An Esc the assistant pressed in an app must reach that app.
	if injected(notchVkEscape, 0, true) || injected(notchVkEscape, 0, false) {
		t.Fatal("an Esc a program sent was kept from the app")
	}
	// A pair a program pressed must never be a yes.
	injected(notchVkLWin, 0, true)
	injected(notchVkLMenu, 0, true)
	injected(notchVkLMenu, 0, false)
	injected(notchVkLWin, 0, false)
	// Nor does text it types count as "another key".
	injected(0x41, 7, true)
	if len(r.fed) != 0 {
		t.Fatalf("keys a program sent were fed on: %v", r.fed)
	}
	if !r.w.idle() {
		t.Fatal("keys a program sent were taken as held")
	}
}

// A key let go over a window that runs as administrator never reaches the
// hook. The watch finds out by asking, and a talk that had started ends.
func TestNotchWinKeysHealEndsWhatAnUnseenReleaseLeftHanging(t *testing.T) {
	var h notchHeard
	kb := newNotchKeyboard(notchTestPairs, h.say, h.mask)
	r := newNotchWinRig()
	r.w.feed = kb.key
	r.down(notchVkLControl)
	r.down(notchVkLWin)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if said, _ := h.got(); len(said) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if said, _ := h.got(); !reflect.DeepEqual(said, []notchKeyAction{notchKeyTalkStart}) {
		t.Fatalf("holding the pair: %v", said)
	}
	// Both keys come up where the hook cannot see.
	r.heldNow[notchVkLControl], r.heldNow[notchVkLWin] = false, false
	r.w.heal()
	if said, _ := h.got(); !reflect.DeepEqual(said, []notchKeyAction{notchKeyTalkStart, notchKeyTalkEnd}) {
		t.Fatalf("after healing: %v", said)
	}
	if !r.w.idle() {
		t.Fatal("after healing nothing should be thought down")
	}
	// With nothing wrong, healing says nothing.
	r.w.heal()
	if said, _ := h.got(); len(said) != 2 {
		t.Fatalf("healing with nothing wrong said something: %v", said)
	}
}

// Ctrl came up while the screen was locked and the hook never heard. The next
// press of anything finds out, or Win alone would be taken for Ctrl + Win.
func TestNotchWinKeysAKeyThatCameUpUnseenIsForgotten(t *testing.T) {
	r := newNotchWinRig()
	r.down(notchVkLControl)
	r.heldNow[notchVkLControl] = false // it came up, unseen
	r.fed = nil
	r.down(notchVkLWin)
	if !reflect.DeepEqual(r.fed, []notchFed{{notchKeyModifiers, notchModMeta}}) {
		t.Fatalf("fed %v, want the Windows key alone", r.fed)
	}
}

func TestNotchWinKeysEscIsFedWithTheModifiersAndKeptWhenTold(t *testing.T) {
	r := newNotchWinRig()
	if r.down(notchVkEscape) || r.up(notchVkEscape) {
		t.Fatal("Esc was kept though nothing asked for it")
	}
	r.keep = true
	if !r.down(notchVkEscape) || !r.up(notchVkEscape) {
		t.Fatal("Esc was not kept though it was asked for")
	}
	r.keep = false
	r.down(notchVkLMenu)
	r.down(notchVkEscape)
	want := []notchFed{{notchKeyEscDown, 0}, {notchKeyEscUp, 0}, {notchKeyEscDown, 0}, {notchKeyEscUp, 0}, {notchKeyModifiers, notchModAlt}, {notchKeyEscDown, notchModAlt}}
	if !reflect.DeepEqual(r.fed, want) {
		t.Fatalf("fed %v", r.fed)
	}
}

// The whole way through, with the real deciding behind the hook's logic:
// the checks done by hand in Notepad.
func TestNotchWinKeysThroughToWhatTheKeysSay(t *testing.T) {
	var h notchHeard
	kb := newNotchKeyboard(notchTestPairs, h.say, h.mask)
	r := newNotchWinRig()
	r.w.feed = kb.key

	// Win + Alt, tapped: yes, and the harmless key was sent while they were down.
	r.down(notchVkLWin)
	r.down(notchVkLMenu)
	r.up(notchVkLMenu)
	r.up(notchVkLWin)
	if said, masks := h.got(); !reflect.DeepEqual(said, []notchKeyAction{notchKeyYes}) || masks != 1 {
		t.Fatalf("Win + Alt: said %v, harmless key sent %d times", said, masks)
	}
	// AltGr + E: nothing.
	r.w.see(notchWinKey{Vk: notchVkLControl, Scan: notchScanAltGrCtrl, Down: true})
	r.heldNow[notchVkLControl] = true
	r.down(notchVkRMenu)
	r.down(0x45)
	r.up(0x45)
	r.up(notchVkRMenu)
	r.heldNow[notchVkLControl] = false
	// Win + E, Ctrl + C: nothing.
	r.down(notchVkLWin)
	r.down(0x45)
	r.up(0x45)
	r.up(notchVkLWin)
	r.down(notchVkLControl)
	r.down(0x43)
	r.up(0x43)
	r.up(notchVkLControl)
	if said, masks := h.got(); len(said) != 1 || masks != 1 {
		t.Fatalf("after ordinary shortcuts: said %v, harmless key sent %d times", said, masks)
	}
	// Esc with nothing on the notch is the app's; with something on, ours.
	if r.down(notchVkEscape) || r.up(notchVkEscape) {
		t.Fatal("Esc was kept with nothing on the notch")
	}
	kb.wantEsc(true)
	if !r.down(notchVkEscape) || !r.up(notchVkEscape) {
		t.Fatal("Esc was not kept with something on the notch")
	}
}
