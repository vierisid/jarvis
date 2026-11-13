package main

import (
	"reflect"
	"sync"
	"testing"
	"time"
)

type notchHeard struct {
	mu    sync.Mutex
	said  []notchKeyAction
	masks int
}

func (h *notchHeard) say(a notchKeyAction) { h.mu.Lock(); h.said = append(h.said, a); h.mu.Unlock() }
func (h *notchHeard) mask()                { h.mu.Lock(); h.masks++; h.mu.Unlock() }
func (h *notchHeard) got() ([]notchKeyAction, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]notchKeyAction(nil), h.said...), h.masks
}

// Holding the pair becomes talking by itself, with no further key: a timer
// does it. Then the page is told, and the harmless key is sent.
func TestNotchKeyboardAHoldBecomesTalkingWithoutAnotherKey(t *testing.T) {
	var h notchHeard
	kb := newNotchKeyboard(notchTestPairs, h.say, h.mask)
	kb.key(notchKeyModifiers, notchModCtrl)
	kb.key(notchKeyModifiers, notchModCtrl|notchModMeta)
	if said, _ := h.got(); len(said) != 0 {
		t.Fatalf("talking started at once: %v", said)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if said, _ := h.got(); len(said) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	said, masks := h.got()
	if !reflect.DeepEqual(said, []notchKeyAction{notchKeyTalkStart}) || masks != 1 {
		t.Fatalf("after the hold: said %v, harmless key sent %d times", said, masks)
	}
	kb.key(notchKeyModifiers, notchModCtrl)
	if said, _ := h.got(); !reflect.DeepEqual(said, []notchKeyAction{notchKeyTalkStart, notchKeyTalkEnd}) {
		t.Fatalf("after letting go: %v", said)
	}
}

func TestNotchKeyboardKeepsOnlyEscAndOnlyWhenWanted(t *testing.T) {
	var h notchHeard
	kb := newNotchKeyboard(notchTestPairs, h.say, h.mask)
	if kb.key(notchKeyEscDown, 0) || kb.key(notchKeyEscUp, 0) {
		t.Fatal("Esc was kept with nothing on the notch")
	}
	kb.wantEsc(true)
	if !kb.key(notchKeyEscDown, 0) || !kb.key(notchKeyEscUp, 0) {
		t.Fatal("Esc was not kept with something on the notch")
	}
	if kb.key(notchKeyOther, 0) || kb.key(notchKeyModifiers, notchModMeta) || kb.key(notchKeyModifiers, 0) {
		t.Fatal("a key that is not Esc was kept")
	}
	if said, _ := h.got(); !reflect.DeepEqual(said, []notchKeyAction{notchKeyEsc}) {
		t.Fatalf("said %v", said)
	}
}

// When the watch stops in the middle of talking, the page must not be left
// thinking the keys are still held. It ends as a slip, not as a sentence:
// what was being said is thrown away.
func TestNotchKeyboardResetEndsTalking(t *testing.T) {
	var h notchHeard
	kb := newNotchKeyboard(notchTestPairs, h.say, h.mask)
	kb.key(notchKeyModifiers, notchModCtrl|notchModMeta)
	time.Sleep(time.Duration(notchTalkHoldMs+120) * time.Millisecond)
	kb.reset()
	if said, _ := h.got(); !reflect.DeepEqual(said, []notchKeyAction{notchKeyTalkStart, notchKeyTalkCancel}) {
		t.Fatalf("said %v", said)
	}
	// And a hold that was reset before it became talking never does.
	kb.key(notchKeyModifiers, notchModCtrl|notchModMeta)
	kb.reset()
	time.Sleep(time.Duration(notchTalkHoldMs+120) * time.Millisecond)
	if said, _ := h.got(); len(said) != 2 {
		t.Fatalf("a reset hold still became talking: %v", said)
	}
}

func TestNotchPairsAreReadAndWrittenTheSameWay(t *testing.T) {
	for text, want := range map[string]notchPair{
		"ctrl+meta":      {notchModCtrl, notchModMeta},
		"Ctrl + Win":     {notchModCtrl, notchModMeta},
		"option+cmd":     {notchModAlt, notchModMeta},
		"shift+alt":      {notchModShift, notchModAlt},
		"control+option": {notchModCtrl, notchModAlt},
	} {
		got, err := notchParsePair(text)
		if err != nil || got != want {
			t.Errorf("%q: got %v, %v", text, got, err)
		}
		if back, err := notchParsePair(got.String()); err != nil || back != got {
			t.Errorf("%q written as %q does not read back", text, got.String())
		}
	}
	for _, bad := range []string{"", "ctrl", "ctrl+ctrl", "ctrl+f1", "ctrl+alt+meta", "win+win", "a+b"} {
		if _, err := notchParsePair(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestNotchDefaultPairsAreValidOnEverySystem(t *testing.T) {
	for _, goos := range []string{"windows", "darwin", "linux"} {
		if !notchDefaultPairs(goos).valid() {
			t.Errorf("the default pairs on %s are not valid", goos)
		}
	}
	if notchDefaultPairs("darwin") == notchDefaultPairs("windows") {
		t.Fatal("a Mac has no Windows key: its pairs differ")
	}
}

func TestNotchKeyScriptsAreWhatThePageExpects(t *testing.T) {
	if got := notchKeyScript(notchKeyEscTwice); got != `window.__notch_key&&window.__notch_key("esc-twice");` {
		t.Fatalf("key script: %s", got)
	}
	want := `window.__notch_pairs&&window.__notch_pairs({"talk":["ctrl","meta"],"yes":["meta","alt"]});`
	if got := notchPairsScript(notchTestPairs); got != want {
		t.Fatalf("pairs script: %s", got)
	}
}

// A typo in the settings file must not leave the notch without keys.
func TestNotchPairsFromSettingsFallBackToTheDefaults(t *testing.T) {
	def := notchDefaultPairs("windows")
	for name, c := range map[string]struct {
		talk, yes string
		want      notchKeyPairs
	}{
		"nothing set":           {"", "", def},
		"both set":              {"ctrl+alt", "shift+meta", notchKeyPairs{Talk: notchPair{notchModCtrl, notchModAlt}, Yes: notchPair{notchModShift, notchModMeta}}},
		"only talk set":         {"ctrl+shift", "", notchKeyPairs{Talk: notchPair{notchModCtrl, notchModShift}, Yes: def.Yes}},
		"a typo in one":         {"ctrl+f1", "shift+meta", notchKeyPairs{Talk: def.Talk, Yes: notchPair{notchModShift, notchModMeta}}},
		"the same pair twice":   {"alt+meta", "meta+alt", def},
		"talk set to yes's own": {"meta+alt", "", def},
	} {
		if got := notchPairsFromSettings(c.talk, c.yes, "windows"); got != c.want {
			t.Errorf("%s: got %v", name, got)
		}
	}
}

// The service starts with this system's pairs, takes valid ones, and refuses
// to be left with pairs that are not.
func TestNotchServiceKeepsValidKeyPairs(t *testing.T) {
	svc := &NotchService{}
	if !svc.KeyPairs().valid() {
		t.Fatal("a fresh service should have this system's default pairs")
	}
	want := notchKeyPairs{Talk: notchPair{notchModCtrl, notchModShift}, Yes: notchPair{notchModAlt, notchModMeta}}
	svc.SetKeyPairs(want)
	if svc.KeyPairs() != want {
		t.Fatalf("pairs were not taken: %v", svc.KeyPairs())
	}
	svc.SetKeyPairs(notchKeyPairs{})
	if !svc.KeyPairs().valid() {
		t.Fatal("invalid pairs must fall back to the defaults")
	}
	// With no page up nothing watches the keyboard, and saying Esc is wanted
	// reaches nobody without harm.
	svc.wantEsc(true)
}

// Turning the switch off ends the watch on the keyboard at once, before the
// window has finished closing: Esc must not be taken for a moment longer.
func TestNotchSwitchOffEndsTheKeyWatchAtOnce(t *testing.T) {
	svc := &NotchService{}
	svc.Configure(true)
	stopped := false
	kb := newNotchKeyboard(notchTestPairs, nil, nil)
	kb.stop = func() { stopped = true }
	svc.keys = kb
	svc.Configure(false)
	if !stopped || svc.keys != nil {
		t.Fatalf("the watch was left running: stopped=%v", stopped)
	}
}
