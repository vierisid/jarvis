package main

import (
	"math/rand"
	"reflect"
	"testing"
)

// The pairs as they are on Windows.
var notchTestPairs = notchKeyPairs{
	Talk: notchPair{notchModCtrl, notchModMeta},
	Yes:  notchPair{notchModMeta, notchModAlt},
}

const (
	tCtrl  = notchModCtrl
	tAlt   = notchModAlt
	tWin   = notchModMeta
	tShift = notchModShift
)

// notchKeyPlay plays keys into the engine and writes down everything that
// came out: what was said, what was kept from the app, and when the harmless
// key was sent.
type notchKeyPlay struct {
	t       *testing.T
	k       *notchKeys
	now     int64
	mods    notchMods
	said    []notchKeyAction
	kept    int
	masks   int
	wakeAt  int64
	lastVer notchKeyVerdict
}

func newNotchKeyPlay(t *testing.T) *notchKeyPlay {
	return &notchKeyPlay{t: t, k: newNotchKeys(notchTestPairs), now: 1000}
}

func (s *notchKeyPlay) take(v notchKeyVerdict) {
	s.lastVer = v
	s.said = append(s.said, v.Actions...)
	if v.Swallow {
		s.kept++
	}
	if v.Mask {
		s.masks++
	}
	s.wakeAt = v.WakeAt
}

// wait lets time pass, calling Tick when the engine asked to be called.
func (s *notchKeyPlay) wait(ms int64) *notchKeyPlay {
	end := s.now + ms
	for s.wakeAt != 0 && s.wakeAt <= end {
		s.now = s.wakeAt
		s.take(s.k.Tick(s.now))
	}
	s.now = end
	return s
}

func (s *notchKeyPlay) down(m notchMods) *notchKeyPlay {
	s.mods |= m
	s.take(s.k.Feed(notchKeyEvent{Kind: notchKeyModifiers, Mods: s.mods, At: s.now}))
	return s
}

func (s *notchKeyPlay) up(m notchMods) *notchKeyPlay {
	s.mods &^= m
	s.take(s.k.Feed(notchKeyEvent{Kind: notchKeyModifiers, Mods: s.mods, At: s.now}))
	return s
}

// other is any key that is not a modifier or Esc.
func (s *notchKeyPlay) other() *notchKeyPlay {
	s.take(s.k.Feed(notchKeyEvent{Kind: notchKeyOther, Mods: s.mods, At: s.now}))
	return s
}

func (s *notchKeyPlay) esc() *notchKeyPlay {
	s.take(s.k.Feed(notchKeyEvent{Kind: notchKeyEscDown, Mods: s.mods, At: s.now}))
	s.wait(40)
	s.take(s.k.Feed(notchKeyEvent{Kind: notchKeyEscUp, Mods: s.mods, At: s.now}))
	return s
}

func (s *notchKeyPlay) expect(want ...notchKeyAction) *notchKeyPlay {
	s.t.Helper()
	if len(want) == 0 {
		want = nil
	}
	if !reflect.DeepEqual(s.said, want) {
		s.t.Fatalf("the keys said %v, want %v", s.said, want)
	}
	return s
}

// The numbered tests are the plan's own, the ones done by hand in Notepad.

// 1. Hold Ctrl + Win for two seconds. The notch perks up. Let go and it rests.
func TestNotchKeysHoldingTheTalkPairTalksUntilLetGo(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tCtrl).wait(30).down(tWin).wait(100).expect()
	s.wait(100).expect(notchKeyTalkStart)
	if s.masks != 1 {
		t.Fatalf("the harmless key should be sent once when talking starts, was sent %d times", s.masks)
	}
	s.wait(1800).up(tWin).expect(notchKeyTalkStart, notchKeyTalkEnd)
	s.wait(20).up(tCtrl).expect(notchKeyTalkStart, notchKeyTalkEnd)
	if s.kept != 0 {
		t.Fatal("a modifier key is never kept from the app")
	}
}

func TestNotchKeysTalkPairWorksInEitherOrder(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tWin).wait(30).down(tCtrl).wait(200).up(tCtrl).wait(10).up(tWin)
	s.expect(notchKeyTalkStart, notchKeyTalkEnd)
}

// A quick press of the pair that is let go at once is nothing of ours, and
// Windows is left to do whatever it does with it.
func TestNotchKeysAQuickPressOfTheTalkPairIsNothing(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tCtrl).wait(20).down(tWin).wait(80).up(tWin).wait(10).up(tCtrl).wait(500).expect()
	if s.masks != 0 {
		t.Fatal("nothing was said, so nothing should have been sent")
	}
}

// 2. Tap Win + Alt. That is a yes.
func TestNotchKeysTappingTheYesPairSaysYesOnce(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tWin).wait(60).down(tAlt)
	// Before either key comes up: that is when Start and the menu bar open.
	if s.masks != 1 {
		t.Fatalf("the harmless key should be sent as the pair goes down, was sent %d times", s.masks)
	}
	s.expect().wait(90).up(tAlt).expect(notchKeyYes).wait(15).up(tWin).expect(notchKeyYes)
}

func TestNotchKeysYesWhenBothKeysComeUpAtOnce(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tAlt).wait(40).down(tWin).wait(80).up(tWin | tAlt).expect(notchKeyYes)
}

// 4. Hold Alt for five seconds, then tap Win. Nothing happens.
func TestNotchKeysAltHeldLongThenWinIsNotYes(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tAlt).wait(5000).down(tWin).wait(80).up(tWin).wait(20).up(tAlt).expect()
	if s.masks != 0 {
		t.Fatal("it was not ours, so Windows must be left alone")
	}
}

// Held, it is not a tap.
func TestNotchKeysTheYesPairHeldLongIsNotYes(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tWin).wait(50).down(tAlt).wait(notchYesTapMs + 200).up(tAlt).up(tWin).expect()
}

// 8. Win + E, Win + D, Ctrl + C, Ctrl + V and Alt + Tab are normal.
func TestNotchKeysOrdinaryShortcutsSayNothingAndAreNotTouched(t *testing.T) {
	for name, play := range map[string]func(s *notchKeyPlay){
		"Win + E":      func(s *notchKeyPlay) { s.down(tWin).wait(60).other().wait(40).up(tWin) },
		"Ctrl + C":     func(s *notchKeyPlay) { s.down(tCtrl).wait(60).other().wait(40).up(tCtrl) },
		"Alt + Tab":    func(s *notchKeyPlay) { s.down(tAlt).wait(60).other().wait(40).other().wait(300).up(tAlt) },
		"Win alone":    func(s *notchKeyPlay) { s.down(tWin).wait(90).up(tWin) },
		"Ctrl + Shift": func(s *notchKeyPlay) { s.down(tCtrl).wait(30).down(tShift).wait(400).up(tShift).up(tCtrl) },
		"Ctrl + Win + D": func(s *notchKeyPlay) {
			s.down(tCtrl).wait(20).down(tWin).wait(60).other().wait(600).up(tWin).up(tCtrl)
		},
		"Win + Alt + R":  func(s *notchKeyPlay) { s.down(tWin).wait(20).down(tAlt).wait(60).other().wait(100).up(tAlt).up(tWin) },
		"Ctrl+Shift+Win": func(s *notchKeyPlay) { s.down(tCtrl).down(tShift).down(tWin).wait(600).up(tWin).up(tShift).up(tCtrl) },
		"Ctrl + Alt + Win": func(s *notchKeyPlay) {
			s.down(tCtrl).down(tWin).wait(40).down(tAlt).wait(600).up(tAlt).up(tWin).up(tCtrl)
		},
		"typing": func(s *notchKeyPlay) { s.other().wait(80).other().wait(80).other() },
	} {
		s := newNotchKeyPlay(t)
		play(s)
		s.wait(1000)
		if len(s.said) != 0 || s.kept != 0 {
			t.Errorf("%s: said %v, kept %d keys", name, s.said, s.kept)
		}
	}
}

// A shortcut that grows out of the talk pair after talking began ends the
// talk, and as a slip: what was said so far is not an instruction.
func TestNotchKeysAnotherKeyWhileTalkingEndsIt(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tCtrl).down(tWin).wait(400).other().expect(notchKeyTalkStart, notchKeyTalkCancel)
	s.wait(300).up(tWin).up(tCtrl).expect(notchKeyTalkStart, notchKeyTalkCancel)
}

func TestNotchKeysAThirdModifierWhileTalkingEndsIt(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tCtrl).down(tWin).wait(400).down(tShift).expect(notchKeyTalkStart, notchKeyTalkCancel)
}

// Letting go is the only way a recording ends as a sentence, whichever key
// of the pair comes up first.
func TestNotchKeysOnlyLettingGoEndsTalkingAsASentence(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tCtrl).down(tWin).wait(400).up(tWin).expect(notchKeyTalkStart, notchKeyTalkEnd)
	s.up(tCtrl).expect(notchKeyTalkStart, notchKeyTalkEnd)
	s = newNotchKeyPlay(t)
	s.down(tCtrl).down(tWin).wait(400).up(tCtrl).expect(notchKeyTalkStart, notchKeyTalkEnd)
}

// Letting go of one talk key and pressing Alt must not turn into a yes: this
// press of the keys has had its say.
func TestNotchKeysOnePressOfTheKeysSaysOneThing(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tCtrl).down(tWin).wait(400).up(tCtrl).wait(30).down(tAlt).wait(60).up(tAlt).up(tWin)
	s.expect(notchKeyTalkStart, notchKeyTalkEnd)
	// And once everything is up, the next press starts clean.
	s.wait(200).down(tWin).wait(30).down(tAlt).wait(60).up(tAlt).up(tWin)
	s.expect(notchKeyTalkStart, notchKeyTalkEnd, notchKeyYes)
}

// 6. Press Esc with the notch at rest. Jarvis did not take the key.
func TestNotchKeysEscIsLeftAloneWhileTheNotchHasNothingOn(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.esc().wait(100).esc().expect()
	if s.kept != 0 {
		t.Fatalf("Esc was kept from the app %d times with nothing on the notch", s.kept)
	}
}

func TestNotchKeysEscIsTakenWhileTheNotchHasSomethingOn(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.k.WantEsc(true)
	s.esc().expect(notchKeyEsc)
	// Both the press and the release are kept: an app that got only the
	// release would see a key come up that never went down.
	if s.kept != 2 {
		t.Fatalf("kept %d events, want the press and the release", s.kept)
	}
}

func TestNotchKeysAHeldEscSaysEscOnce(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.k.WantEsc(true)
	for i := 0; i < 5; i++ {
		s.take(s.k.Feed(notchKeyEvent{Kind: notchKeyEscDown, At: s.now}))
		s.wait(30)
	}
	s.take(s.k.Feed(notchKeyEvent{Kind: notchKeyEscUp, At: s.now}))
	s.expect(notchKeyEsc)
	if s.kept != 6 {
		t.Fatalf("every repeat and the release should be kept, kept %d", s.kept)
	}
}

// 7. Press Esc twice. The first has usually put the notch to rest already, so
// the second would not be wanted by itself: it is still the same gesture.
func TestNotchKeysEscTwiceIsItsOwnThing(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.k.WantEsc(true)
	s.esc()
	s.k.WantEsc(false)
	s.wait(150).esc().expect(notchKeyEsc, notchKeyEscTwice)
	if s.kept != 4 {
		t.Fatalf("both presses and both releases should be kept, kept %d", s.kept)
	}
	// A third is judged afresh: nothing is on the notch, so it is the app's.
	s.wait(150).esc().expect(notchKeyEsc, notchKeyEscTwice)
	if s.kept != 4 {
		t.Fatal("a third Esc with nothing on the notch belongs to the app")
	}
}

func TestNotchKeysASlowSecondEscIsNotTwice(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.k.WantEsc(true)
	s.esc().wait(notchEscTwiceMs+100).esc().expect(notchKeyEsc, notchKeyEsc)
	s.k.WantEsc(false)
	s.wait(notchEscTwiceMs+100).esc().expect(notchKeyEsc, notchKeyEsc)
}

// Ctrl + Esc opens Start and Alt + Esc switches windows. They are Windows'.
func TestNotchKeysEscWithAModifierIsNeverTaken(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.k.WantEsc(true)
	s.down(tCtrl).wait(40).esc().up(tCtrl).wait(100).down(tAlt).wait(40).esc().up(tAlt).expect()
	if s.kept != 0 {
		t.Fatal("Esc with a modifier was kept from Windows")
	}
}

// A key that came up while the screen was locked never reached us. The
// platform resets on such moments, and nothing may stay stuck.
func TestNotchKeysResetEndsTalkingAndForgetsEveryKey(t *testing.T) {
	s := newNotchKeyPlay(t)
	s.down(tCtrl).down(tWin).wait(400).expect(notchKeyTalkStart)
	if got := s.k.Reset(); !reflect.DeepEqual(got, []notchKeyAction{notchKeyTalkCancel}) {
		t.Fatalf("reset while talking returned %v", got)
	}
	s.mods, s.said = 0, nil
	// Win alone afterwards is just Win: the Ctrl of before is forgotten.
	s.down(tWin).wait(600).up(tWin).expect()
	if got := s.k.Reset(); got != nil {
		t.Fatalf("reset with nothing going on returned %v", got)
	}
}

func TestNotchKeyPairsCanBeChanged(t *testing.T) {
	mac := notchKeyPairs{Talk: notchPair{notchModCtrl, notchModAlt}, Yes: notchPair{notchModAlt, notchModMeta}}
	s := newNotchKeyPlay(t)
	s.k.SetPairs(mac)
	s.down(tCtrl).down(tAlt).wait(300).up(tAlt).up(tCtrl).expect(notchKeyTalkStart, notchKeyTalkEnd)
	s.said = nil
	s.wait(200).down(tAlt).wait(30).down(tWin).wait(60).up(tWin).up(tAlt).expect(notchKeyYes)
	s.said = nil
	// The Windows pairs no longer mean anything.
	s.wait(200).down(tCtrl).down(tWin).wait(600).up(tWin).up(tCtrl).expect()
}

func TestNotchKeyPairsMustBeTwoDifferentPairsOfModifiers(t *testing.T) {
	if !notchTestPairs.valid() {
		t.Fatal("the default pairs should be valid")
	}
	for name, pairs := range map[string]notchKeyPairs{
		"the same key twice":     {Talk: notchPair{notchModCtrl, notchModCtrl}, Yes: notchPair{notchModMeta, notchModAlt}},
		"the same pair for both": {Talk: notchPair{notchModCtrl, notchModMeta}, Yes: notchPair{notchModMeta, notchModCtrl}},
		"two keys in one slot":   {Talk: notchPair{notchModCtrl | notchModAlt, notchModMeta}, Yes: notchPair{notchModMeta, notchModAlt}},
		"nothing":                {},
	} {
		if pairs.valid() {
			t.Errorf("%s should not be valid", name)
		}
	}
}

// Whatever is typed, however fast: nothing but Esc is ever kept from the app,
// talking always ends, and yes never comes out of a press that had another
// key in it.
func TestNotchKeysNeverKeepAnythingButEscWhateverIsTyped(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for round := 0; round < 400; round++ {
		k := newNotchKeys(notchTestPairs)
		k.WantEsc(rng.Intn(2) == 0)
		var mods notchMods
		now := int64(1000)
		talking := false
		for step := 0; step < 120; step++ {
			now += int64(rng.Intn(260))
			var ev notchKeyEvent
			switch r := rng.Intn(10); {
			case r < 5:
				mods ^= notchMods(1 << uint(rng.Intn(4)))
				ev = notchKeyEvent{Kind: notchKeyModifiers, Mods: mods, At: now}
			case r < 7:
				ev = notchKeyEvent{Kind: notchKeyOther, Mods: mods, At: now}
			case r < 8:
				ev = notchKeyEvent{Kind: notchKeyEscDown, Mods: mods, At: now}
			case r < 9:
				ev = notchKeyEvent{Kind: notchKeyEscUp, Mods: mods, At: now}
			default:
				for _, a := range k.Tick(now).Actions {
					if a == notchKeyTalkStart {
						talking = true
					}
				}
				continue
			}
			v := k.Feed(ev)
			if v.Swallow && ev.Kind != notchKeyEscDown && ev.Kind != notchKeyEscUp {
				t.Fatalf("round %d: a key that is not Esc was kept from the app: %+v", round, ev)
			}
			for _, a := range v.Actions {
				switch a {
				case notchKeyTalkStart:
					t.Fatalf("round %d: talking started on a key event, not on a hold", round)
				case notchKeyTalkEnd, notchKeyTalkCancel:
					if !talking {
						t.Fatalf("round %d: talking ended that never started", round)
					}
					talking = false
				case notchKeyYes:
					if ev.Kind != notchKeyModifiers {
						t.Fatalf("round %d: yes came from %+v", round, ev)
					}
				}
			}
		}
		// Let go of everything: nothing may be left talking.
		for _, a := range k.Feed(notchKeyEvent{Kind: notchKeyModifiers, Mods: 0, At: now + 10}).Actions {
			if a == notchKeyTalkEnd || a == notchKeyTalkCancel {
				talking = false
			}
		}
		if talking {
			t.Fatalf("round %d: still talking with every key up", round)
		}
	}
}

func TestNotchKeyActionsHaveTheNamesThePageKnows(t *testing.T) {
	names := map[notchKeyAction]string{
		notchKeyTalkStart: "talk-start", notchKeyTalkEnd: "talk-end", notchKeyYes: "yes", notchKeyEsc: "esc", notchKeyEscTwice: "esc-twice",
		notchKeyTalkCancel: "talk-cancel",
	}
	for action, want := range names {
		if action.String() != want {
			t.Errorf("%d is called %q, want %q", action, action.String(), want)
		}
	}
}
