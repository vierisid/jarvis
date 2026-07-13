package main

import "testing"

func TestParseKeyCombo(t *testing.T) {
	cases := []struct {
		combo     string
		wantNil   bool
		key       string
		code      string
		keyCode   int
		modifiers int
		text      string
		display   string
	}{
		{combo: "Enter", key: "Enter", code: "Enter", keyCode: 13, text: "\r", display: "Enter"},
		{combo: "escape", key: "Escape", code: "Escape", keyCode: 27, display: "Escape"},
		{combo: "Tab", key: "Tab", code: "Tab", keyCode: 9, display: "Tab"},
		{combo: "ArrowDown", key: "ArrowDown", code: "ArrowDown", keyCode: 40, display: "ArrowDown"},
		{combo: "a", key: "a", code: "KeyA", keyCode: 65, text: "a", display: "A"},
		{combo: "K", key: "k", code: "KeyK", keyCode: 75, text: "k", display: "K"},
		{combo: "7", key: "7", code: "Digit7", keyCode: 55, text: "7", display: "7"},
		{combo: "/", key: "/", code: "Slash", keyCode: 191, text: "/", display: "/"},
		{combo: "Ctrl+K", key: "k", code: "KeyK", keyCode: 75, modifiers: 2, display: "Ctrl+K"},
		{combo: "Shift+Enter", key: "Enter", code: "Enter", keyCode: 13, modifiers: 8, text: "\r", display: "Shift+Enter"},
		{combo: "Ctrl+Shift+M", key: "M", code: "KeyM", keyCode: 77, modifiers: 10, display: "Ctrl+Shift+M"},
		{combo: "Shift+a", key: "A", code: "KeyA", keyCode: 65, modifiers: 8, text: "A", display: "Shift+A"},
		{combo: "Cmd+A", key: "a", code: "KeyA", keyCode: 65, modifiers: 4, display: "Meta+A"},
		{combo: "Space", key: " ", code: "Space", keyCode: 32, text: " ", display: "Space"},
		{combo: "F5", key: "F5", code: "F5", keyCode: 116, display: "F5"},
		{combo: "", wantNil: true},
		{combo: "NotAKey", wantNil: true},
		{combo: "Ctrl+", wantNil: true},
		{combo: "Foo+K", wantNil: true},
		{combo: "Ctrl++", wantNil: true},
	}

	for _, c := range cases {
		got := parseKeyCombo(c.combo)
		if c.wantNil {
			if got != nil {
				t.Errorf("parseKeyCombo(%q) = %+v, want nil", c.combo, got)
			}
			continue
		}
		if got == nil {
			t.Errorf("parseKeyCombo(%q) = nil, want key %q", c.combo, c.key)
			continue
		}
		if got.Key != c.key || got.Code != c.code || got.KeyCode != c.keyCode ||
			got.Modifiers != c.modifiers || got.Text != c.text || got.Display != c.display {
			t.Errorf("parseKeyCombo(%q) = %+v, want key=%q code=%q keyCode=%d modifiers=%d text=%q display=%q",
				c.combo, got, c.key, c.code, c.keyCode, c.modifiers, c.text, c.display)
		}
	}
}

// Shift+Enter keeps text "\r" (Shift doesn't suppress text; Ctrl/Alt/Meta do).
func TestParseKeyComboModifierTextSuppression(t *testing.T) {
	if pk := parseKeyCombo("Shift+Enter"); pk == nil || pk.Text != "\r" {
		t.Errorf("Shift+Enter should keep text, got %+v", pk)
	}
	if pk := parseKeyCombo("Ctrl+Enter"); pk == nil || pk.Text != "" {
		t.Errorf("Ctrl+Enter should suppress text, got %+v", pk)
	}
	if pk := parseKeyCombo("Alt+/"); pk == nil || pk.Text != "" {
		t.Errorf("Alt+/ should suppress text, got %+v", pk)
	}
}
