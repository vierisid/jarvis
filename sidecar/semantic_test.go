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

func TestPathSegmentsMatchBetweenWalkAndRecorder(t *testing.T) {
	// The snapshot walk and the recorder must produce byte-identical path
	// segments, or a recorded sig can never equal a live one.
	long := "Impostazioni avanzate per la sicurezza dell'account personale"
	seg := pathSegment("Group", long)
	if seg["role"] != "Group" {
		t.Fatalf("role: %v", seg["role"])
	}
	if got := seg["name"].(string); got != truncateRunes(long, pathNameRunes) {
		t.Fatalf("segment name must be cut at %d runes, got %q", pathNameRunes, got)
	}
	win := windowSegment("Inbox (3) - someone@example.com - Gmail - Google Chrome")
	if win["role"] != "Window" {
		t.Fatalf("the root segment is always a Window, got %v", win["role"])
	}
	if got := win["name"].(string); len([]rune(got)) != pathNameRunes {
		t.Fatalf("window title must be cut at %d runes, got %d", pathNameRunes, len([]rune(got)))
	}
}

func TestSiblingOrdinalCountsEarlierSameKeySiblings(t *testing.T) {
	sibs := []siblingKey{
		{"Button", "Send"}, {"Text", "Send"}, {"Button", "Discard"}, {"Button", "Send"}, {"Button", "Send"},
	}
	if got := siblingOrdinal(sibs, 0); got != 0 {
		t.Fatalf("first Send button is ordinal 0, got %d", got)
	}
	if got := siblingOrdinal(sibs, 1); got != 0 {
		t.Fatalf("a Text named Send is its own key, got %d", got)
	}
	if got := siblingOrdinal(sibs, 3); got != 1 {
		t.Fatalf("second Send button is ordinal 1, got %d", got)
	}
	if got := siblingOrdinal(sibs, 4); got != 2 {
		t.Fatalf("third Send button is ordinal 2, got %d", got)
	}
	if got := siblingOrdinal(sibs, 9); got != 0 {
		t.Fatalf("out of range is 0, got %d", got)
	}
}

func TestRecordedSigEqualsWalkSigForTheSameElement(t *testing.T) {
	// Both sides feed semanticSig the same normalized fields: element name
	// cut at elementNameRunes, path built from windowSegment + pathSegment,
	// ordinal from siblingOrdinal.
	title := "Compose - Gmail"
	name := truncateRunes("Send", elementNameRunes)
	path := []map[string]any{windowSegment(title), pathSegment("Pane", "Chrome Legacy Window"), pathSegment("Group", "New Message")}
	sibs := []siblingKey{{"Button", "Discard"}, {"Button", "Send"}}
	walk := semanticSig("Button", name, "", path, siblingOrdinal(sibs, 1))
	recorded := semanticSig("Button", name, "", []map[string]any{windowSegment(title), pathSegment("Pane", "Chrome Legacy Window"), pathSegment("Group", "New Message")}, 0)
	if walk != recorded {
		t.Fatalf("recorded sig %s must equal walk sig %s", recorded, walk)
	}
	// And the old recorder shape (no path, ordinal 0) does not.
	if old := semanticSig("Button", name, "", nil, 0); old == walk {
		t.Fatal("a sig without ancestry must not collide with the walk's")
	}
}
