package main

import (
	"fmt"
	"strings"
	"time"
)

// ── Trusted input primitives: press key, hover, rich click ───────────
//
// These mirror the daemon's local browser primitives (src/actions/browser/
// session.ts + keys.ts) so templates behave the same whether the browser is
// local or sidecar-routed. Key/mouse events go through CDP Input.dispatch*
// (trusted events), not synthetic JS events — hover-revealed toolbars and
// app keyboard shortcuts only respond to trusted input.

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
var keyModifierBits = map[string]int{
	"alt": 1, "option": 1, "opt": 1,
	"ctrl": 2, "control": 2,
	"meta": 4, "cmd": 4, "command": 4, "win": 4,
	"shift": 8,
}

type keyDef struct {
	Key     string
	Code    string
	KeyCode int
	Text    string // empty = key produces no text
}

var namedKeys = map[string]keyDef{
	"enter":     {"Enter", "Enter", 13, "\r"},
	"tab":       {"Tab", "Tab", 9, ""},
	"escape":    {"Escape", "Escape", 27, ""},
	"esc":       {"Escape", "Escape", 27, ""},
	"backspace": {"Backspace", "Backspace", 8, ""},
	"delete":    {"Delete", "Delete", 46, ""},
	"del":       {"Delete", "Delete", 46, ""},
	"space":     {" ", "Space", 32, " "},
	"arrowup":   {"ArrowUp", "ArrowUp", 38, ""},
	"up":        {"ArrowUp", "ArrowUp", 38, ""},
	"arrowdown": {"ArrowDown", "ArrowDown", 40, ""},
	"down":      {"ArrowDown", "ArrowDown", 40, ""},
	"arrowleft": {"ArrowLeft", "ArrowLeft", 37, ""},
	"left":      {"ArrowLeft", "ArrowLeft", 37, ""},
	"arrowright": {"ArrowRight", "ArrowRight", 39, ""},
	"right":      {"ArrowRight", "ArrowRight", 39, ""},
	"home":     {"Home", "Home", 36, ""},
	"end":      {"End", "End", 35, ""},
	"pageup":   {"PageUp", "PageUp", 33, ""},
	"pagedown": {"PageDown", "PageDown", 34, ""},
	"/":        {"/", "Slash", 191, "/"},
	".":        {".", "Period", 190, "."},
	",":        {",", "Comma", 188, ","},
	";":        {";", "Semicolon", 186, ";"},
	"'":        {"'", "Quote", 222, "'"},
	"[":        {"[", "BracketLeft", 219, "["},
	"]":        {"]", "BracketRight", 221, "]"},
	"\\":       {"\\", "Backslash", 220, "\\"},
	"`":        {"`", "Backquote", 192, "`"},
	"-":        {"-", "Minus", 189, "-"},
	"=":        {"=", "Equal", 187, "="},
	"?":        {"?", "Slash", 191, "?"},
	"@":        {"@", "Digit2", 50, "@"},
	"#":        {"#", "Digit3", 51, "#"},
}

func init() {
	for i := 1; i <= 12; i++ {
		name := fmt.Sprintf("f%d", i)
		label := fmt.Sprintf("F%d", i)
		namedKeys[name] = keyDef{label, label, 111 + i, ""}
	}
}

type parsedKey struct {
	Key       string
	Code      string
	KeyCode   int
	Modifiers int
	Text      string
	Display   string
}

// parseKeyCombo parses "Ctrl+Shift+M" style combos: the last "+"-separated
// part is the key, everything before it must be modifiers. Returns nil for
// unsupported keys.
func parseKeyCombo(combo string) *parsedKey {
	trimmed := strings.TrimSpace(combo)
	if trimmed == "" {
		return nil
	}
	parts := strings.Split(trimmed, "+")
	for _, p := range parts {
		if p == "" {
			return nil
		}
	}

	keyName := parts[len(parts)-1]
	modifiers := 0
	var displayMods []string
	for _, m := range parts[:len(parts)-1] {
		bit, ok := keyModifierBits[strings.ToLower(m)]
		if !ok {
			return nil
		}
		if modifiers&bit == 0 {
			modifiers |= bit
			switch bit {
			case 1:
				displayMods = append(displayMods, "Alt")
			case 2:
				displayMods = append(displayMods, "Ctrl")
			case 4:
				displayMods = append(displayMods, "Meta")
			case 8:
				displayMods = append(displayMods, "Shift")
			}
		}
	}

	var def keyDef
	if d, ok := namedKeys[strings.ToLower(keyName)]; ok {
		def = d
	} else if len(keyName) == 1 {
		ch := keyName[0]
		switch {
		case ch >= 'a' && ch <= 'z':
			def = keyDef{string(ch), "Key" + strings.ToUpper(string(ch)), int(ch - 'a' + 'A'), string(ch)}
		case ch >= 'A' && ch <= 'Z':
			lc := ch - 'A' + 'a'
			def = keyDef{string(lc), "Key" + string(ch), int(ch), string(lc)}
		case ch >= '0' && ch <= '9':
			def = keyDef{string(ch), "Digit" + string(ch), int(ch), string(ch)}
		default:
			return nil
		}
	} else {
		return nil
	}

	key := def.Key
	text := def.Text
	// Shift on a letter produces the uppercase character
	if modifiers&8 != 0 && len(key) == 1 && key[0] >= 'a' && key[0] <= 'z' {
		key = strings.ToUpper(key)
		text = key
	}
	// Ctrl/Alt/Meta suppress text production (shortcut, not typing)
	if modifiers&(1|2|4) != 0 {
		text = ""
	}

	displayKey := def.Key
	if displayKey == " " {
		displayKey = "Space"
	} else if len(displayKey) == 1 {
		displayKey = strings.ToUpper(displayKey)
	} else {
		displayKey = key
	}

	return &parsedKey{
		Key:       key,
		Code:      def.Code,
		KeyCode:   def.KeyCode,
		Modifiers: modifiers,
		Text:      text,
		Display:   strings.Join(append(displayMods, displayKey), "+"),
	}
}

func makeBrowserPressKeyHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		combo, _ := params["key"].(string)
		if combo == "" {
			return nil, fmt.Errorf("missing required parameter: key")
		}
		pk := parseKeyCombo(combo)
		if pk == nil {
			// Same message the daemon's local pressKey returns, so the LLM gets
			// consistent guidance regardless of routing.
			return &RPCResult{Result: fmt.Sprintf(
				`Error: Unsupported key "%s". Supported: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, letters, digits, common punctuation — optionally prefixed with Ctrl+/Alt+/Shift+/Meta+ (e.g. "Ctrl+K", "Shift+Enter").`, combo)}, nil
		}

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		down := map[string]any{
			"type":                  "rawKeyDown",
			"key":                   pk.Key,
			"code":                  pk.Code,
			"windowsVirtualKeyCode": pk.KeyCode,
			"nativeVirtualKeyCode":  pk.KeyCode,
			"modifiers":             pk.Modifiers,
		}
		if pk.Text != "" {
			down["type"] = "keyDown"
			down["text"] = pk.Text
		}
		if _, err := cdp.send("Input.dispatchKeyEvent", down); err != nil {
			return nil, fmt.Errorf("key down failed: %w", err)
		}
		if _, err := cdp.send("Input.dispatchKeyEvent", map[string]any{
			"type":                  "keyUp",
			"key":                   pk.Key,
			"code":                  pk.Code,
			"windowsVirtualKeyCode": pk.KeyCode,
			"nativeVirtualKeyCode":  pk.KeyCode,
			"modifiers":             pk.Modifiers,
		}); err != nil {
			return nil, fmt.Errorf("key up failed: %w", err)
		}

		// Let the app react (menu open, mode switch, etc.)
		time.Sleep(300 * time.Millisecond)

		return &RPCResult{Result: fmt.Sprintf("Pressed %s", pk.Display)}, nil
	}
}

func makeBrowserHoverHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		elemID, ok := params["element_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("missing required parameter: element_id")
		}

		cdp, err := getCDPForParams(cfg, params)
		if err != nil {
			return nil, err
		}

		id := int(elemID)
		coords, found := cdp.elementCoordsFor(id)
		if !found {
			return &RPCResult{Result: fmt.Sprintf("Error: Element [%d] not found. Run browser_snapshot first.", id)}, nil
		}
		x, y := coords[0], coords[1]

		// Approach from a nearby point so mouseenter/mouseover always fire
		approachX, approachY := x-10, y-10
		if approachX < 0 {
			approachX = 0
		}
		if approachY < 0 {
			approachY = 0
		}
		for _, pt := range [][2]float64{{approachX, approachY}, {x, y}} {
			if _, err := cdp.send("Input.dispatchMouseEvent", map[string]any{
				"type": "mouseMoved",
				"x":    pt[0],
				"y":    pt[1],
			}); err != nil {
				return nil, fmt.Errorf("hover move failed: %w", err)
			}
		}

		// Give the app time to render hover-triggered UI
		time.Sleep(600 * time.Millisecond)

		return &RPCResult{Result: fmt.Sprintf(
			"Hovering over element [%d]. Take a browser_snapshot to see any hover-revealed elements, then act before moving the mouse elsewhere.", id)}, nil
	}
}

// dispatchClick sends a trusted mouse click at (x, y). double sends the
// two-press sequence (clickCount 1 then 2) Chromium expects for dblclick.
func dispatchClick(cdp *cdpClient, x, y float64, button string, double bool) error {
	if _, err := cdp.send("Input.dispatchMouseEvent", map[string]any{
		"type": "mouseMoved", "x": x, "y": y,
	}); err != nil {
		return err
	}
	clicks := 1
	if double {
		clicks = 2
	}
	for count := 1; count <= clicks; count++ {
		for _, evType := range []string{"mousePressed", "mouseReleased"} {
			if _, err := cdp.send("Input.dispatchMouseEvent", map[string]any{
				"type":       evType,
				"x":          x,
				"y":          y,
				"button":     button,
				"clickCount": count,
			}); err != nil {
				return err
			}
		}
	}
	return nil
}
