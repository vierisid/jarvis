package main

// semantic.go — durable element addressing shared by all surface providers
// (UIA, CDP, AX, AT-SPI).

import (
	"fmt"
	"hash/fnv"
)

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
