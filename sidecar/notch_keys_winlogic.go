package main

// What the Windows keyboard hook makes of each key. It is in a file of its
// own, with no Windows call in it, so that it is tested wherever the tests
// run and not only on Windows.
//
// The rule it keeps: a key is Esc, one of the eight modifier keys, or
// "another key". Which other key is looked at only to tell it is not one of
// those, and is passed on to nobody.

const (
	notchLlkhfInjected = 0x10

	notchVkEscape   = 0x1B
	notchVkLWin     = 0x5B
	notchVkRWin     = 0x5C
	notchVkLShift   = 0xA0
	notchVkRShift   = 0xA1
	notchVkLControl = 0xA2
	notchVkRControl = 0xA3
	notchVkLMenu    = 0xA4
	notchVkRMenu    = 0xA5

	// A key code that no keyboard has and no app listens for. Sending it while
	// the Windows key or Alt is down makes that key "used", which is all it
	// takes for Start and the menu bar to stay shut.
	notchVkMask = 0xE8
	// Marks the key above as ours.
	notchKeyTag = 0x4A4E4B31

	// On a layout with AltGr, pressing it also sends a left Ctrl that nobody
	// pressed. That Ctrl has this scan code, which a real one never has.
	notchScanAltGrCtrl = 0x21D
)

// The eight modifier keys, and which modifier each is.
var notchModifierKeys = [8]struct {
	vk  uint32
	mod notchMods
}{
	{notchVkLControl, notchModCtrl}, {notchVkRControl, notchModCtrl},
	{notchVkLMenu, notchModAlt}, {notchVkRMenu, notchModAlt},
	{notchVkLWin, notchModMeta}, {notchVkRWin, notchModMeta},
	{notchVkLShift, notchModShift}, {notchVkRShift, notchModShift},
}

// notchWinKey is one key event as the hook receives it.
type notchWinKey struct {
	Vk, Scan, Flags uint32
	Extra           uintptr
	Down            bool
}

// notchWinWatch turns the hook's key events into what notchKeys is fed.
type notchWinWatch struct {
	// feed hands on what was seen and reports whether to keep the key from
	// the app in front.
	feed func(kind notchKeyKind, mods notchMods) bool
	// held asks Windows whether a key is down right now.
	held func(vk uint32) bool
	// Which of the eight modifier keys are down, as the hook has seen them.
	down [8]bool
	// The right Alt key is down as AltGr: it types letters then, and is not Alt.
	altGr bool
}

// see takes one key event and reports whether to keep it from the app.
func (w *notchWinWatch) see(k notchWinKey) bool {
	// A key a program sent is not a key a person pressed, and only a person
	// talks to the notch. This is not only about our own harmless key: Jarvis
	// itself types and presses keys in other apps, and an Esc it pressed there
	// must reach that app, and a pair it pressed must never be a yes to its
	// own offer. The cost is that keys sent by a remapping tool are not seen.
	if k.Flags&notchLlkhfInjected != 0 {
		return false
	}
	// The Ctrl that AltGr sends along is not a Ctrl.
	if k.Vk == notchVkLControl && k.Scan == notchScanAltGrCtrl {
		return false
	}
	if k.Vk == notchVkEscape {
		if k.Down {
			return w.feed(notchKeyEscDown, w.mods())
		}
		return w.feed(notchKeyEscUp, w.mods())
	}
	for i, key := range notchModifierKeys {
		if key.vk != k.Vk {
			continue
		}
		// The right Alt of a layout with AltGr is "another key". It is known
		// by the Ctrl it brought: Windows has a left Ctrl down that this watch
		// never saw pressed.
		if k.Vk == notchVkRMenu && (w.altGr || (k.Down && !w.down[0] && w.held(notchVkLControl))) {
			w.altGr = k.Down
			if k.Down {
				return w.feed(notchKeyOther, w.mods())
			}
			return false
		}
		if k.Down && !w.down[i] {
			// A fresh press is the moment to check the others: a key that came
			// up while the screen was locked never told us.
			w.resync()
		}
		if w.down[i] == k.Down {
			// The key repeating while it is held: nothing changed.
			return false
		}
		w.down[i] = k.Down
		return w.feed(notchKeyModifiers, w.mods())
	}
	if k.Down {
		return w.feed(notchKeyOther, w.mods())
	}
	return false
}

func (w *notchWinWatch) mods() notchMods {
	var m notchMods
	for i, key := range notchModifierKeys {
		if w.down[i] {
			m |= key.mod
		}
	}
	return m
}

// resync drops any modifier this watch believes is down and Windows says is up.
func (w *notchWinWatch) resync() {
	for i, key := range notchModifierKeys {
		if w.down[i] && !w.held(key.vk) {
			w.down[i] = false
		}
	}
}

// heal checks what this watch believes is down against what Windows says,
// and tells the deciding code if a key had come up unseen. A key let go over
// a window that runs as administrator, or while the screen was locked, never
// reaches the hook; without this a talk that had started would never end.
func (w *notchWinWatch) heal() {
	before := w.mods()
	w.resync()
	if w.altGr && !w.held(notchVkRMenu) {
		w.altGr = false
	}
	if now := w.mods(); now != before {
		w.feed(notchKeyModifiers, now)
	}
}

// idle: no key this watch cares about is down.
func (w *notchWinWatch) idle() bool {
	for _, d := range w.down {
		if d {
			return false
		}
	}
	return !w.altGr
}
