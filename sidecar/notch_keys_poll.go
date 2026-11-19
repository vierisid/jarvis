package main

// The notch's two pairs of keys, read without any permission.
//
// The keys are watched with an event tap on macOS (notch_keys_darwin.go), and
// a tap needs the Accessibility permission. A person who has not given it yet,
// or whose Mac does not honour it, had a notch that only the mouse could
// answer: on the third run on a real Mac (19 November 2026) the permission was
// switched on and macOS still refused, and the first Mac user stopped there
// ("it doesnt work the hotkeys that are crucial").
//
// The two pairs are modifier keys, and which modifiers are down is something
// any program may ask at any time. So without the tap the keyboard is not
// heard but looked at, many times a second: which modifiers are down now, how
// many keys have gone down since the system started (a count, never which),
// and whether Esc is down. That is enough for the pairs: held, tapped, and
// "another key came in between", which is what tells a tap of Option + Cmd
// from Option + Cmd + D.
//
// What it cannot do is keep a key from the app in front. Esc is heard and
// acted on, and the app in front gets it too. And the mouse is not seen, so
// drawing round a thing while the pair is held still needs the permission.
//
// This file is the turning of looks into the events the keys' engine takes
// (notch_keys.go). It has no platform in it; the looking itself is in
// notch_keys_darwin.go.

// notchKeyLook is the keyboard at one instant.
type notchKeyLook struct {
	// Which modifiers are down.
	Mods notchMods
	// How many keys have gone down since some fixed moment. Only ever compared
	// with the look before; it may wrap round.
	Downs uint32
	// Whether Esc is down.
	Esc bool
}

// notchPolled is one event for the engine.
type notchPolled struct {
	Kind notchKeyKind
	Mods notchMods
}

// The modifiers that make a key somebody's shortcut. Shift alone does not:
// Shift + a letter is typing.
const notchShortcutMods = notchModCtrl | notchModAlt | notchModMeta

// notchKeyPoll remembers the look before.
type notchKeyPoll struct {
	seen bool
	last notchKeyLook
}

// step takes the newest look and gives the events since the one before, in
// the order they are to be fed.
//
// The first look says nothing: a key that was already down when the watching
// began was not pressed for the notch.
func (p *notchKeyPoll) step(now notchKeyLook) []notchPolled {
	if !p.seen {
		p.seen, p.last = true, now
		return nil
	}
	was := p.last
	p.last = now
	var out []notchPolled
	// How many keys went down between the two looks. Modifiers are not counted
	// by the system among these.
	downs := now.Downs - was.Downs
	if now.Mods != was.Mods {
		// A key that went down in the same instant as modifiers came up was
		// pressed while they were held: it is told first, with them still down,
		// or the letting go would read as a clean tap.
		heldBefore := was.Mods&notchShortcutMods != 0
		releasing := now.Mods&^was.Mods == 0
		if downs > 0 && heldBefore && releasing && !(now.Esc && !was.Esc) {
			out = append(out, notchPolled{Kind: notchKeyOther, Mods: was.Mods})
			downs = 0
		}
		out = append(out, notchPolled{Kind: notchKeyModifiers, Mods: now.Mods})
	}
	if now.Esc != was.Esc {
		if now.Esc {
			out = append(out, notchPolled{Kind: notchKeyEscDown, Mods: now.Mods})
			// Esc going down is one of the keys counted.
			if downs > 0 {
				downs--
			}
		} else {
			out = append(out, notchPolled{Kind: notchKeyEscUp, Mods: now.Mods})
		}
	}
	// Any other key matters only while Ctrl, Option or Cmd is held, as with
	// the tap: plain typing is never told to the engine.
	if downs > 0 && now.Mods&notchShortcutMods != 0 {
		out = append(out, notchPolled{Kind: notchKeyOther, Mods: now.Mods})
	}
	return out
}

// reset forgets the look before, so the next one says nothing. For a watch
// that was interrupted: what happened meanwhile was not seen.
func (p *notchKeyPoll) reset() { p.seen = false }
