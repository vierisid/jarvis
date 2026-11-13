package main

// The notch's keys.
//
// Three things can be said to the notch from the keyboard, anywhere:
//
//   - talk: hold a pair of modifier keys (Ctrl + Win; on a Mac Ctrl + Option)
//   - yes:  tap another pair (Win + Alt; on a Mac Option + Cmd)
//   - Esc, once or twice, but only while the notch has something on it
//
// Pairs of modifiers were chosen because they type nothing and belong to no
// app. The price is that they have to be seen going down and coming up, which
// a registered hotkey cannot do, so the platform watches the keyboard and
// feeds this file what it saw. This file is the whole of the deciding, and it
// has no platform in it.
//
// What it is told, and all it is told: which modifier keys are down, that Esc
// went down or came up, or that "some other key" went down. It is never told
// which other key. Nothing a person types can be learned from here, and
// nothing here keeps a history beyond the last few timestamps.

// notchMods is the set of modifier keys that are down. Left and right keys are
// the same modifier.
type notchMods uint8

const (
	notchModCtrl notchMods = 1 << iota
	notchModAlt            // Alt; Option on a Mac
	notchModMeta           // the Windows key; Cmd on a Mac
	notchModShift
)

// notchKeyKind is what kind of key event the platform saw.
type notchKeyKind uint8

const (
	// A modifier went down or came up. Mods says which are down now.
	notchKeyModifiers notchKeyKind = iota
	// Esc went down, or came up.
	notchKeyEscDown
	notchKeyEscUp
	// Any other key went down. Which one is not passed on.
	notchKeyOther
)

// notchKeyEvent is one thing the platform saw. Mods is the truth after the
// event, read from the system each time and not counted up from past events:
// a key that came up while the screen was locked must not stay down here.
type notchKeyEvent struct {
	Kind notchKeyKind
	Mods notchMods
	// Milliseconds on any steady clock. Never 0: here 0 means "no time".
	At int64
}

// notchKeyAction is something the keys said.
type notchKeyAction uint8

const (
	notchKeyTalkStart notchKeyAction = iota + 1
	notchKeyTalkEnd
	notchKeyYes
	notchKeyEsc
	notchKeyEscTwice
	// Talking ended, but not by letting go: another key was pressed with the
	// pair held, or the keyboard could no longer be trusted. What was said is
	// not an instruction, and is thrown away.
	notchKeyTalkCancel
)

// The name each action has for the page (window.__notch_key).
func (a notchKeyAction) String() string {
	switch a {
	case notchKeyTalkStart:
		return "talk-start"
	case notchKeyTalkEnd:
		return "talk-end"
	case notchKeyYes:
		return "yes"
	case notchKeyEsc:
		return "esc"
	case notchKeyEscTwice:
		return "esc-twice"
	case notchKeyTalkCancel:
		return "talk-cancel"
	}
	return ""
}

// notchKeyVerdict is what the platform must do about the event it just fed in.
type notchKeyVerdict struct {
	Actions []notchKeyAction
	// Keep the event from the app in front. Only ever true for Esc.
	Swallow bool
	// Send the harmless key now, so that letting go of the Windows key or Alt
	// does not open the Start menu or the menu bar.
	Mask bool
	// Call Tick at this time (same clock as At) unless something is fed first.
	// 0 means no call is wanted.
	WakeAt int64
}

const (
	// The talk pair must be held this long alone before it counts. A shortcut
	// that starts with the same two keys (Ctrl + Win + D) has its third key
	// down well inside this.
	notchTalkHoldMs = 150
	// The two keys of yes must go down within this of each other.
	notchYesTogetherMs = 700
	// And come up again within this of going down: it is a tap, not a hold.
	notchYesTapMs = 1500
	// A second Esc this soon after one that was taken is "twice".
	notchEscTwiceMs = 400
)

// notchPair is two different modifiers.
type notchPair [2]notchMods

func (p notchPair) mask() notchMods { return p[0] | p[1] }

// valid: two single modifiers, not the same one.
func (p notchPair) valid() bool {
	single := func(m notchMods) bool { return m != 0 && m&(m-1) == 0 && m <= notchModShift }
	return single(p[0]) && single(p[1]) && p[0] != p[1]
}

// notchKeyPairs is which pair talks and which says yes, on one machine.
type notchKeyPairs struct {
	Talk notchPair
	Yes  notchPair
}

// valid: both are pairs, and they are not the same two keys.
func (k notchKeyPairs) valid() bool {
	return k.Talk.valid() && k.Yes.valid() && k.Talk.mask() != k.Yes.mask()
}

// notchKeys turns what the platform saw into what the keys said.
type notchKeys struct {
	pairs notchKeyPairs
	// The page has something on it that Esc would close or stop.
	wantEsc bool

	mods    notchMods
	downAt  [4]int64 // when each modifier last went down, by bit
	spent   bool     // this press of the modifiers has had its say, or lost it
	talkAt  int64    // when the talk pair became the only keys down; 0 if not
	talking bool
	yesAt   int64 // when the yes pair became the only keys down; 0 if not

	escHeld  bool  // an Esc that was taken is still down
	escTaken int64 // when an Esc was last taken as the first of a possible two; 0 if none
}

func newNotchKeys(pairs notchKeyPairs) *notchKeys {
	return &notchKeys{pairs: pairs}
}

// SetPairs changes the pairs. Whatever was half pressed is forgotten.
func (k *notchKeys) SetPairs(pairs notchKeyPairs) (ended []notchKeyAction) {
	ended = k.Reset()
	k.pairs = pairs
	return ended
}

// WantEsc says whether the notch has something Esc would close or stop.
func (k *notchKeys) WantEsc(want bool) { k.wantEsc = want }

// Reset forgets every key. It is for when the keyboard cannot be trusted any
// more: the watch stopped, or the session was locked. If the person was
// talking, that ends.
func (k *notchKeys) Reset() (ended []notchKeyAction) {
	if k.talking {
		ended = []notchKeyAction{notchKeyTalkCancel}
	}
	pairs, want := k.pairs, k.wantEsc
	*k = notchKeys{pairs: pairs, wantEsc: want}
	return ended
}

func notchModIndex(m notchMods) int {
	switch m {
	case notchModCtrl:
		return 0
	case notchModAlt:
		return 1
	case notchModMeta:
		return 2
	}
	return 3
}

// Feed takes one event and says what to do about it.
func (k *notchKeys) Feed(ev notchKeyEvent) notchKeyVerdict {
	var v notchKeyVerdict
	switch ev.Kind {
	case notchKeyEscDown:
		k.escDown(ev, &v)
	case notchKeyEscUp:
		if k.escHeld {
			k.escHeld = false
			v.Swallow = true
		}
	case notchKeyOther:
		// Another key while modifiers are down makes it somebody's shortcut.
		k.lose(&v)
	case notchKeyModifiers:
		k.modifiers(ev, &v)
	}
	k.wake(&v)
	return v
}

// Tick is called at the time a verdict asked for. It is where a hold becomes
// talking.
func (k *notchKeys) Tick(now int64) notchKeyVerdict {
	var v notchKeyVerdict
	if k.talkAt != 0 && !k.talking && !k.spent && now-k.talkAt >= notchTalkHoldMs {
		k.talking = true
		k.talkAt = 0
		v.Actions = append(v.Actions, notchKeyTalkStart)
		v.Mask = true
	}
	k.wake(&v)
	return v
}

func (k *notchKeys) wake(v *notchKeyVerdict) {
	if k.talkAt != 0 && !k.talking && !k.spent {
		v.WakeAt = k.talkAt + notchTalkHoldMs
	}
}

// lose ends whatever this press of the modifiers was becoming.
func (k *notchKeys) lose(v *notchKeyVerdict) {
	if k.talking {
		// A key that is not one of the pair: this was somebody's shortcut, or
		// a slip. Either way it was not the end of a sentence.
		k.talking = false
		v.Actions = append(v.Actions, notchKeyTalkCancel)
	}
	k.talkAt, k.yesAt = 0, 0
	if k.mods != 0 {
		k.spent = true
	}
}

func (k *notchKeys) modifiers(ev notchKeyEvent, v *notchKeyVerdict) {
	was, now := k.mods, ev.Mods
	k.mods = now
	for bit := notchModCtrl; bit <= notchModShift; bit <<= 1 {
		if now&bit != 0 && was&bit == 0 {
			k.downAt[notchModIndex(bit)] = ev.At
		}
	}
	if now == 0 {
		// Everything is up. Whatever was happening is over, and the next
		// press starts clean.
		if k.talking {
			k.talking = false
			v.Actions = append(v.Actions, notchKeyTalkEnd)
		} else if k.yesAt != 0 && !k.spent && ev.At-k.yesAt <= notchYesTapMs {
			v.Actions = append(v.Actions, notchKeyYes)
		}
		k.talkAt, k.yesAt, k.spent = 0, 0, false
		return
	}
	talk, yes := k.pairs.Talk.mask(), k.pairs.Yes.mask()
	if k.talking {
		// Letting go of either key ends it. A third modifier going down
		// ends it too, but as a slip: nothing is done with what was said.
		if now != talk {
			k.talking = false
			k.spent = true
			if now&^talk != 0 {
				v.Actions = append(v.Actions, notchKeyTalkCancel)
			} else {
				v.Actions = append(v.Actions, notchKeyTalkEnd)
			}
		}
		return
	}
	if k.yesAt != 0 {
		// The pair was down. A key of it coming up is the tap; anything else
		// (a third modifier) is not ours.
		if now&^yes == 0 && now != yes {
			if !k.spent && ev.At-k.yesAt <= notchYesTapMs {
				v.Actions = append(v.Actions, notchKeyYes)
			}
			k.yesAt = 0
			k.spent = true
			return
		}
		if now != yes {
			k.yesAt = 0
			k.spent = true
		}
		return
	}
	if k.spent {
		return
	}
	switch {
	case now == talk:
		if k.talkAt == 0 {
			k.talkAt = ev.At
		}
	case now == yes:
		k.talkAt = 0
		a, b := k.downAt[notchModIndex(k.pairs.Yes[0])], k.downAt[notchModIndex(k.pairs.Yes[1])]
		gap := a - b
		if gap < 0 {
			gap = -gap
		}
		if gap <= notchYesTogetherMs {
			k.yesAt = ev.At
			// Now, before either key comes up: the Start menu and the menu bar
			// open on the way up.
			v.Mask = true
		} else {
			// Held one, then the other much later: not a tap of two.
			k.spent = true
		}
	case now&^talk == 0 || now&^yes == 0:
		// One key of a pair so far. Wait for the other.
		k.talkAt = 0
	default:
		// Some other set of modifiers: somebody's shortcut.
		k.talkAt = 0
		k.spent = true
	}
}

func (k *notchKeys) escDown(ev notchKeyEvent, v *notchKeyVerdict) {
	if k.escHeld {
		// The key repeating while it is held: still ours, and says nothing more.
		v.Swallow = true
		return
	}
	// Esc with a modifier is Windows' own (Ctrl + Esc, Alt + Esc), and it also
	// spoils a pair in the making.
	if ev.Mods != 0 {
		k.lose(v)
		return
	}
	again := k.escTaken != 0 && ev.At-k.escTaken <= notchEscTwiceMs
	// The second of two is taken even if the first already put the notch to
	// rest: it is still the same gesture.
	if !k.wantEsc && !again {
		k.escTaken = 0
		return
	}
	k.escHeld = true
	v.Swallow = true
	if again {
		// The gesture is complete: a third Esc is judged afresh.
		k.escTaken = 0
		v.Actions = append(v.Actions, notchKeyEscTwice)
		return
	}
	k.escTaken = ev.At
	v.Actions = append(v.Actions, notchKeyEsc)
}
