package main

// What the Mac's side of looking, watching and doing has that is plain
// deciding, with no call into the system in it: which Mac keys are steps and
// what they are called, and what a Mac control is called in the words the
// rest of this program already uses. Kept apart from notch_look_darwin.go and
// notch_watch_darwin.go, which can only be compiled on a Mac, so that this
// much is tested on every system.

import (
	"fmt"
	"strings"
)

// The Mac's keys that have a name, by their key code. These are the names
// press_keys takes, so a key that was watched can be pressed again as it is.
// "delete" is the key that deletes forward; the one above Return is
// "backspace", as it is on every other keyboard.
var watchMacNamedKeys = map[int]string{
	36: "enter", 76: "enter", 48: "tab", 117: "delete", 114: "insert",
	116: "pageup", 121: "pagedown", 119: "end", 115: "home",
	123: "left", 126: "up", 124: "right", 125: "down",
	122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6",
	98: "f7", 100: "f8", 101: "f9", 109: "f10", 103: "f11", 111: "f12",
}

// The key code of each named key, for pressing it again.
var watchMacKeyCodes = map[string]int{
	"enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "insert": 114,
	"pageup": 116, "pagedown": 121, "end": 119, "home": 115,
	"left": 123, "up": 126, "right": 124, "down": 125,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
	"f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
}

// The key codes of the letters and digits on the keyboard Apple sells in the
// United States, used only when the keyboard in use will not say where its
// letters are.
var watchMacAnsiKeys = map[byte]int{
	'a': 0, 's': 1, 'd': 2, 'f': 3, 'h': 4, 'g': 5, 'z': 6, 'x': 7, 'c': 8, 'v': 9, 'b': 11,
	'q': 12, 'w': 13, 'e': 14, 'r': 15, 'y': 16, 't': 17, '1': 18, '2': 19, '3': 20, '4': 21,
	'6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29, 'o': 31, 'u': 32, 'i': 34, 'p': 35,
	'l': 37, 'j': 38, 'k': 40, 'n': 45, 'm': 46,
}

// watchKeyMac says what a key going down on a Mac is: a step with its name,
// typing, or nothing. code is the key's code. letter is the letter or digit
// the key stands for and is only ever given when Cmd or Ctrl is held: a key
// pressed without them never has its letter looked at, here or before here.
//
// What is a step: a named key (Return, Tab, the arrows, Home, End, Page Up
// and Down, the key that deletes forward, F1 to F12), alone or with others
// held; and a letter or a digit with Cmd or Ctrl. Option with a letter types
// a sign on a Mac (Option + E is an accent), so it is typing.
func watchKeyMac(code int, letter byte, m watchMods) (watchKeyKind, string) {
	if code == 53 {
		// Esc is the notch's own.
		return watchKeyNone, ""
	}
	with := func(name string) string {
		parts := make([]string, 0, 5)
		if m.Ctrl {
			parts = append(parts, "ctrl")
		}
		if m.Alt {
			parts = append(parts, "alt")
		}
		if m.Cmd {
			parts = append(parts, "cmd")
		}
		if m.Shift {
			parts = append(parts, "shift")
		}
		return strings.Join(append(parts, name), ",")
	}
	if name, ok := watchMacNamedKeys[code]; ok {
		return watchKeyStep, with(name)
	}
	if m.Cmd || m.Ctrl {
		switch {
		case (letter >= 'a' && letter <= 'z') || (letter >= '0' && letter <= '9'):
			return watchKeyStep, with(string(rune(letter)))
		case code == 51:
			return watchKeyStep, with("backspace")
		case code == 49:
			return watchKeyStep, with("space")
		}
	}
	return watchKeyTyped, ""
}

// macKeys is keys as watchKeyMac names them, taken apart for pressing: which
// keys are held, and the one key that is pressed (its name, or its letter).
type macKeys struct {
	Ctrl, Alt, Cmd, Shift bool
	Name                  string
}

// parseMacKeys reads a key spec ("cmd,c", "shift,down"). An error for
// anything that is not one named key or one letter with the keys held.
func parseMacKeys(spec string) (macKeys, error) {
	var keys macKeys
	for _, part := range strings.Split(spec, ",") {
		switch part {
		case "ctrl":
			keys.Ctrl = true
		case "alt":
			keys.Alt = true
		case "cmd", "win":
			// A job shown on Windows names the Windows key; on a Mac that key is Cmd.
			keys.Cmd = true
		case "shift":
			keys.Shift = true
		case "":
			return keys, fmt.Errorf("an empty key in %q", spec)
		default:
			if keys.Name != "" {
				return keys, fmt.Errorf("more than one key in %q", spec)
			}
			keys.Name = part
		}
	}
	if keys.Name == "" {
		return keys, fmt.Errorf("no key in %q", spec)
	}
	if _, named := watchMacKeyCodes[keys.Name]; !named && !(len(keys.Name) == 1 && ((keys.Name[0] >= 'a' && keys.Name[0] <= 'z') || (keys.Name[0] >= '0' && keys.Name[0] <= '9'))) {
		return keys, fmt.Errorf("no key called %q", keys.Name)
	}
	return keys, nil
}

// The words a Mac has for its controls, in the words the Windows side uses
// for the same things. The rest of the look (what kind of thing a person
// would call it, where a climb stops, what takes a thing that is put) is
// written in those words, and is the same code on both systems.
var macRoles = map[string]string{
	"AXButton": "Button", "AXPopUpButton": "ComboBox", "AXMenuButton": "SplitButton", "AXDisclosureTriangle": "Button",
	"AXTextField": "Edit", "AXSearchField": "Edit", "AXSecureTextField": "Edit", "AXComboBox": "ComboBox",
	"AXTextArea": "Document", "AXWebArea": "Document",
	"AXStaticText": "Text", "AXHeading": "Text", "AXImage": "Image", "AXLink": "Hyperlink",
	"AXCheckBox": "CheckBox", "AXRadioButton": "RadioButton", "AXSwitch": "CheckBox",
	"AXRow": "ListItem", "AXOutlineRow": "TreeItem", "AXCell": "DataItem", "AXColumnHeader": "HeaderItem",
	"AXMenuItem": "MenuItem", "AXMenuBarItem": "MenuItem", "AXTab": "TabItem",
	"AXWindow": "Window", "AXSheet": "Window", "AXDialog": "Window", "AXDrawer": "Pane",
	"AXGroup": "Group", "AXScrollArea": "Pane", "AXSplitGroup": "Pane", "AXLayoutArea": "Pane",
	"AXList": "List", "AXTable": "Table", "AXOutline": "Tree", "AXGrid": "DataGrid", "AXBrowser": "Tree",
	"AXTabGroup": "Tab", "AXToolbar": "ToolBar", "AXMenu": "Menu", "AXMenuBar": "MenuBar",
	"AXSlider": "Slider", "AXProgressIndicator": "ProgressBar", "AXScrollBar": "ScrollBar",
}

// macRole gives a Mac control's kind in the Windows side's words, and the
// plain word a person would use where the kind alone does not say it ("row",
// "cell", "heading", "link").
func macRole(role, subrole string) (kind, local string) {
	switch {
	case subrole == "AXTabButton":
		return "TabItem", ""
	case role == "AXRow" || role == "AXOutlineRow":
		kind, _ := macRoles[role]
		return kind, "row"
	case role == "AXCell":
		return "DataItem", "cell"
	case role == "AXHeading":
		return "Text", "heading"
	case role == "AXLink":
		return "Hyperlink", "link"
	}
	if kind, ok := macRoles[role]; ok {
		return kind, ""
	}
	return "Custom", ""
}

// macActsOn says whether a control is one a person presses, picks or types
// into: these are what "where is...?" may point at.
func macActsOn(kind string) bool {
	switch kind {
	case "Button", "SplitButton", "ComboBox", "Edit", "Hyperlink", "CheckBox", "RadioButton",
		"MenuItem", "TabItem", "ListItem", "TreeItem", "DataItem", "HeaderItem", "Slider":
		return true
	}
	return false
}
