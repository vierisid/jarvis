package main

import "testing"

func TestTruncateRunesKeepsWholeCharacters(t *testing.T) {
	in := "Impostazioni avanzate è qui"
	got := truncateRunes(in, 23)
	if got != "Impostazioni avanzate è" {
		t.Fatalf("truncateRunes cut inside a character: %q", got)
	}
	if truncateRunes("abc", 10) != "abc" {
		t.Fatal("short strings must pass through unchanged")
	}
	if truncateRunes("abc", 0) != "" {
		t.Fatal("n=0 must yield an empty string")
	}
}

func TestSemanticSigIsDeterministicAndOrdinalSensitive(t *testing.T) {
	path := []map[string]any{{"role": "Window", "name": "Inbox"}}
	a := semanticSig("Button", "Send", "", path, 0)
	b := semanticSig("Button", "Send", "", path, 0)
	c := semanticSig("Button", "Send", "", path, 1)
	if a != b {
		t.Fatal("same inputs must hash the same")
	}
	if a == c {
		t.Fatal("ordinal must change the sig")
	}
}
