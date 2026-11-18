package main

// A letter or a digit as the key that carries it, for a shortcut.
//
// A shortcut names a key, not a sign: Ctrl+C is the C key with Ctrl, and
// Ctrl+1 the 1 key, whatever those keys type. Asking the keyboard layout
// which key types the sign gets it wrong in two ways. On a French keyboard
// the 1 key types "&" and needs Shift for "1", so Ctrl+1 was pressed as
// Ctrl+Shift+1, another shortcut. On a Russian, Greek or Hebrew layout no key
// types "c" at all, so Ctrl+C and Ctrl+V could not be pressed, and every copy
// and paste of a job failed. The key's own code is the same on all of them.
func plainKeyVk(name string) (uint16, bool) {
	if len(name) != 1 {
		return 0, false
	}
	c := name[0]
	switch {
	case c >= 'a' && c <= 'z':
		return uint16('A' + (c - 'a')), true
	case c >= 'A' && c <= 'Z':
		return uint16(c), true
	case c >= '0' && c <= '9':
		return uint16(c), true
	}
	return 0, false
}

// shortcutMods are the keys that make what is held with them a shortcut.
// Shift alone does not: Shift and a letter is that letter, typed.
var shortcutMods = map[string]bool{"ctrl": true, "control": true, "alt": true, "win": true, "windows": true, "meta": true, "super": true, "cmd": true}

// notchPressOnPlace says whether the pointer is where a press was meant to
// go: within two pixels, which is what a display's rounding can move it by.
func notchPressOnPlace(x, y, wantX, wantY int) bool {
	dx, dy := x-wantX, y-wantY
	return dx >= -2 && dx <= 2 && dy >= -2 && dy <= 2
}

// notchActStillIn says whether a place that was pointed at while one program
// was there may still be acted on, with this program there now. Both are
// names as the never list holds them. Nothing asked ("") is yes.
func notchActStillIn(asked, now string) bool {
	return asked == "" || asked == now
}
