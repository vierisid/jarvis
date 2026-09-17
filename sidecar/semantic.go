package main

// semantic.go — durable element addressing shared by all surface providers
// (UIA, CDP, AX, AT-SPI).

import (
	"fmt"
	"hash/fnv"
)

// Name limits shared by every producer of a SemanticRef. The element's own
// name is cut at elementNameRunes before it enters the sig; an ancestor's
// name inside the path is cut at pathNameRunes. The snapshot walk and the
// recorder must agree on both, or a recorded sig can never equal a live one.
const (
	elementNameRunes = 100
	pathNameRunes    = 40
)

// pathSegment is one ancestor in a ref's ancestry path, as the snapshot
// walk and the recorder both build it.
func pathSegment(role, name string) map[string]any {
	return map[string]any{"role": role, "name": truncateRunes(name, pathNameRunes)}
}

// windowSegment is the root segment of every path: the top-level window,
// always with role "Window" whatever its UIA control type says.
func windowSegment(title string) map[string]any {
	return pathSegment("Window", title)
}

// siblingKey identifies a sibling for ordinal purposes.
type siblingKey struct {
	Ctrl string
	Name string // already cut at elementNameRunes
}

// siblingOrdinal is the index of siblings[self] among the siblings that
// share its control type and name, counting every sibling (visible or not)
// so an ordinal does not shift when a neighbour is hidden. Mirrors the
// ordinal the snapshot walk assigns.
func siblingOrdinal(siblings []siblingKey, self int) int {
	if self < 0 || self >= len(siblings) {
		return 0
	}
	ord := 0
	for i := 0; i < self; i++ {
		if siblings[i] == siblings[self] {
			ord++
		}
	}
	return ord
}

// truncateRunes shortens s to at most n characters. Names are cut before
// they go into refs and payloads; slicing bytes would split a multi-byte
// character (accented letters are the norm in non-English UIs) and leave
// U+FFFD in the JSON. Truncating whole runes keeps names readable and the
// sig deterministic. Shared by every platform; the notification code on
// Windows used to carry its own copy.
func truncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// semanticSig computes the durable, content-derived signature for an element:
// hash(control_type | name | automation_id | ancestry path | ordinal). This —
// not the session-scoped integer id — is what skills and the daemon-side
// resolver store, so a target can be re-found after ids churn or the UI
// relayouts (rot-proof addressing).
func semanticSig(ctrl, name, autoID string, path []map[string]any, ordinal int) string {
	h := fnv.New64a()
	write := func(s string) { h.Write([]byte(s)); h.Write([]byte{0}) }
	write(ctrl)
	write(name)
	write(autoID)
	for _, p := range path {
		role, _ := p["role"].(string)
		pname, _ := p["name"].(string)
		write(role + "/" + pname)
	}
	write(fmt.Sprintf("%d", ordinal))
	return fmt.Sprintf("%016x", h.Sum64())
}
