package main

import (
	"reflect"
	"testing"
)

// The third run on a real Mac (19 November 2026): the Accessibility permission
// was switched on, macOS did not honour it, and the keys stayed dead. The two
// pairs are now also read by looking at the keyboard's state, which needs no
// permission. These are the rules that turn looks into what the engine takes.

const (
	pollTalk = notchModCtrl | notchModAlt
	pollYes  = notchModAlt | notchModMeta
)

func pollRun(looks ...notchKeyLook) []notchPolled {
	var p notchKeyPoll
	var out []notchPolled
	for _, look := range looks {
		out = append(out, p.step(look)...)
	}
	return out
}

func TestPollTheFirstLookSaysNothing(t *testing.T) {
	// The pair was already down when the watching began: not pressed for the notch.
	if got := pollRun(notchKeyLook{Mods: pollTalk, Downs: 40, Esc: true}); got != nil {
		t.Fatalf("first look fed %v", got)
	}
}

func TestPollAPairHeldAndLetGo(t *testing.T) {
	got := pollRun(
		notchKeyLook{},
		notchKeyLook{Mods: notchModCtrl},
		notchKeyLook{Mods: pollTalk},
		notchKeyLook{Mods: pollTalk},
		notchKeyLook{Mods: notchModAlt},
		notchKeyLook{},
	)
	want := []notchPolled{
		{notchKeyModifiers, notchModCtrl},
		{notchKeyModifiers, pollTalk},
		{notchKeyModifiers, notchModAlt},
		{notchKeyModifiers, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPollAnotherKeyWhileThePairIsHeldIsTold(t *testing.T) {
	// Option + Cmd + D: a shortcut of the system's, not a yes.
	got := pollRun(
		notchKeyLook{Downs: 7},
		notchKeyLook{Mods: pollYes, Downs: 7},
		notchKeyLook{Mods: pollYes, Downs: 8},
		notchKeyLook{Downs: 8},
	)
	want := []notchPolled{
		{notchKeyModifiers, pollYes},
		{notchKeyOther, pollYes},
		{notchKeyModifiers, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPollAKeyThatWentDownAsThePairCameUpIsToldFirst(t *testing.T) {
	// Both between two looks: the key was pressed while the pair was held, so
	// the engine must hear of it before it hears the pair come up.
	got := pollRun(
		notchKeyLook{Mods: pollYes, Downs: 3},
		notchKeyLook{Mods: pollYes, Downs: 3},
		notchKeyLook{Downs: 4},
	)
	want := []notchPolled{
		{notchKeyOther, pollYes},
		{notchKeyModifiers, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPollPlainTypingIsNeverTold(t *testing.T) {
	got := pollRun(
		notchKeyLook{Downs: 100},
		notchKeyLook{Downs: 103},
		// Shift + a letter is typing too.
		notchKeyLook{Mods: notchModShift, Downs: 103},
		notchKeyLook{Mods: notchModShift, Downs: 105},
		notchKeyLook{Downs: 105},
	)
	want := []notchPolled{
		{notchKeyModifiers, notchModShift},
		{notchKeyModifiers, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPollEscIsToldAsEscAndNotAsAnotherKey(t *testing.T) {
	got := pollRun(
		notchKeyLook{Downs: 10},
		notchKeyLook{Downs: 11, Esc: true},
		notchKeyLook{Downs: 11},
	)
	want := []notchPolled{
		{notchKeyEscDown, 0},
		{notchKeyEscUp, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// With the pair held, Esc alone is Esc and nothing more: it is one of the
	// keys the system counted, and must not be told a second time as "another".
	got = pollRun(
		notchKeyLook{Mods: pollTalk, Downs: 10},
		notchKeyLook{Mods: pollTalk, Downs: 11, Esc: true},
	)
	want = []notchPolled{{notchKeyEscDown, pollTalk}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Esc alone with the pair: got %v, want %v", got, want)
	}
	// With the pair held, Esc is Esc, and a second key in the same instant is another key.
	got = pollRun(
		notchKeyLook{Mods: pollTalk, Downs: 10},
		notchKeyLook{Mods: pollTalk, Downs: 12, Esc: true},
	)
	want = []notchPolled{
		{notchKeyEscDown, pollTalk},
		{notchKeyOther, pollTalk},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("with the pair: got %v, want %v", got, want)
	}
}

func TestPollTheCountMayWrapRound(t *testing.T) {
	got := pollRun(
		notchKeyLook{Mods: pollYes, Downs: 0xFFFFFFFF},
		notchKeyLook{Mods: pollYes, Downs: 1},
	)
	want := []notchPolled{{notchKeyOther, pollYes}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPollAfterAResetTheNextLookSaysNothing(t *testing.T) {
	var p notchKeyPoll
	p.step(notchKeyLook{})
	p.reset()
	if got := p.step(notchKeyLook{Mods: pollTalk, Downs: 9}); got != nil {
		t.Fatalf("after a reset: %v", got)
	}
	if got := p.step(notchKeyLook{Downs: 9}); !reflect.DeepEqual(got, []notchPolled{{notchKeyModifiers, 0}}) {
		t.Fatalf("then: %v", got)
	}
}

// The whole way: looks in, what the keys said out, through the real engine.
func pollSaid(t *testing.T, at []int64, looks []notchKeyLook) []notchKeyAction {
	t.Helper()
	engine := newNotchKeys(notchKeyPairs{Talk: notchPair{notchModCtrl, notchModAlt}, Yes: notchPair{notchModAlt, notchModMeta}})
	var p notchKeyPoll
	var said []notchKeyAction
	for i, look := range looks {
		// A hold becomes talking by the clock, not by an event.
		said = append(said, engine.Tick(at[i]).Actions...)
		for _, e := range p.step(look) {
			said = append(said, engine.Feed(notchKeyEvent{Kind: e.Kind, Mods: e.Mods, At: at[i]}).Actions...)
		}
	}
	return said
}

func TestPollATapOfTheYesPairIsAYes(t *testing.T) {
	said := pollSaid(t,
		[]int64{1, 10, 20, 90, 100},
		[]notchKeyLook{{}, {Mods: notchModAlt}, {Mods: pollYes}, {Mods: notchModMeta}, {}},
	)
	if !reflect.DeepEqual(said, []notchKeyAction{notchKeyYes}) {
		t.Fatalf("said %v, want one yes", said)
	}
}

func TestPollAShortcutThatStartsWithTheYesPairIsNotAYes(t *testing.T) {
	said := pollSaid(t,
		[]int64{1, 10, 20, 60, 90, 100},
		[]notchKeyLook{{Downs: 5}, {Mods: notchModAlt, Downs: 5}, {Mods: pollYes, Downs: 5}, {Mods: pollYes, Downs: 6}, {Mods: notchModMeta, Downs: 6}, {Downs: 6}},
	)
	if len(said) != 0 {
		t.Fatalf("said %v, want nothing", said)
	}
}

func TestPollHoldingTheTalkPairIsTalkingUntilItIsLetGo(t *testing.T) {
	said := pollSaid(t,
		[]int64{1, 10, 20, 400, 900, 910},
		[]notchKeyLook{{}, {Mods: notchModCtrl}, {Mods: pollTalk}, {Mods: pollTalk}, {Mods: notchModCtrl}, {}},
	)
	if !reflect.DeepEqual(said, []notchKeyAction{notchKeyTalkStart, notchKeyTalkEnd}) {
		t.Fatalf("said %v, want talk-start then talk-end", said)
	}
}
