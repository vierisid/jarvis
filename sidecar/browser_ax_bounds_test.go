package main

// #597 on the ACCESSIBILITY path. The AX reply carried three page-controlled
// values with no bound at all -- `title`, `url` and each element's `value` --
// and `axMaxElements` budgeted only the static-text context, so every
// interactive element was emitted however many there were. An ordinary big
// page (a few thousand links, or one textarea holding a megabyte) therefore
// built a reply past the brain's 2 MB cap, and the whole AX read was dropped
// silently: no elements and no reason.

import (
	"encoding/json"
	"strings"
	"testing"
)

func axStr(s string) *axValue {
	raw, _ := json.Marshal(s)
	return &axValue{Value: raw}
}

// axNodesWith builds `count` emittable interactive nodes, each with the given
// accessible name and value.
func axNodesWith(count int, name, value string) []axNode {
	nodes := make([]axNode, 0, count)
	for i := 0; i < count; i++ {
		nodes = append(nodes, axNode{
			NodeID:           string(rune('a'+i%26)) + strings.Repeat("x", i/26+1),
			Role:             axStr("button"),
			Name:             axStr(name),
			Value:            axStr(value),
			BackendDOMNodeID: int64(i + 1),
		})
	}
	return nodes
}

// axReplyBytes is what the brain actually measures: the marshalled reply, in
// the units `MAX_JSON_SIZE` counts.
//
// Measuring THIS, and not the budget function, is the point. An earlier version
// of this test summed `axElementCost` and compared it to `axReplyBudget` --
// production arithmetic against its own production constant, which can only
// agree with itself. It passed while a page of ampersands built a 3.8 MB reply,
// because the cost function estimated raw bytes and Go's encoder escapes `<`,
// `>` and `&` to six each.
func axReplyBytes(t *testing.T, elements []map[string]any) int {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"provider":      "cdp",
		"url":           "https://mail.example.com/u/0/#inbox",
		"title":         "Inbox",
		"element_count": len(elements),
		"elements":      elements,
		"captured_at":   int64(1764000000000),
	})
	if err != nil {
		t.Fatalf("marshal reply: %v", err)
	}
	return len(raw)
}

const maxJSONSize = 2 * 1024 * 1024

func TestAXReplySizeIsBounded(t *testing.T) {
	// Five thousand links is a big table, not an attack. Unbounded, that reply
	// crossed the brain's 2 MB cap and the model got nothing at all.
	out := buildAXElements(axNodesWith(5000, "Open the message from Jane", ""))
	if got := axReplyBytes(t, out); got > maxJSONSize {
		t.Fatalf("the reply is %d bytes, over the %d cap that drops it", got, maxJSONSize)
	}
	if len(out) >= 5000 {
		t.Fatalf("all %d elements were emitted, so nothing is bounding the reply", len(out))
	}
	// And it must bite far above any honest page: dropping interactive
	// elements to make room for CONTEXT is the thing this must not become.
	if len(out) < axMaxElements {
		t.Fatalf("the bound bit far too early: %d elements", len(out))
	}
	// Interactive elements still come first, which is the ordering the cap must
	// not disturb: the actionable ones are the point of the reply.
	if role, _ := out[0]["role"].(string); role != "button" {
		t.Fatalf("expected an interactive element first, got role %q", role)
	}
}

func TestAXPayloadIsBounded(t *testing.T) {
	// Each element carries the biggest value the per-field cap allows.
	out := buildAXElements(axNodesWith(2000, strings.Repeat("n", 100), strings.Repeat("v", axMaxValue*2)))
	for _, el := range out {
		value, _ := el["value"].(string)
		if got := len([]rune(value)); got > axMaxValue {
			t.Fatalf("a value of %d characters survived the %d cap", got, axMaxValue)
		}
	}
	if got := axReplyBytes(t, out); got > maxJSONSize {
		t.Fatalf("the reply is %d bytes, over the %d cap that drops it", got, maxJSONSize)
	}
	// The budget has to bite here: 2000 x (100 + 1000) is well past it, so a
	// test that passed with every element emitted would prove nothing.
	if len(out) >= 2000 {
		t.Fatalf("the budget emitted all %d elements, so it is not bounding anything", len(out))
	}
	if len(out) == 0 {
		t.Fatal("the budget must still emit what fits")
	}
}

// TestAXReplySizeIsBoundedForEscapedText is the case the estimate could not
// see: every character the page chose is one Go's encoder writes as six bytes.
func TestAXReplySizeIsBoundedForEscapedText(t *testing.T) {
	for _, fill := range []string{"&", "<", ">"} {
		out := buildAXElements(axNodesWith(2000, strings.Repeat(fill, 100), strings.Repeat(fill, axMaxValue)))
		got := axReplyBytes(t, out)
		if got > maxJSONSize {
			t.Fatalf("a page of %q built a %d byte reply, over the %d cap that drops it whole",
				fill, got, maxJSONSize)
		}
		if len(out) == 0 {
			t.Fatalf("a page of %q emitted nothing", fill)
		}
	}
}

// TestAXIdentityFieldStaysComparable is the #594 rule applied in reverse:
// truncate what is RENDERED, never what is BRANCHED ON. `ui_act` refuses to
// act when the surface it re-reads has a different url or title than the one
// reviewed, and on the AX path that comparison is the only document check
// there is -- so two different documents must not become equal by being cut.
func TestAXIdentityFieldStaysComparable(t *testing.T) {
	ordinary := "https://mail.example.com/u/0/#inbox"
	if got := axIdentityField(ordinary, maxRenderedURL); got != ordinary {
		t.Fatalf("a URL under the cap must be untouched, got %q", got)
	}

	prefix := "https://evil.example/?pad=" + strings.Repeat("a", maxRenderedURL)
	one := axIdentityField(prefix+"#one", maxRenderedURL)
	two := axIdentityField(prefix+"#two", maxRenderedURL)
	if one == two {
		t.Fatal("two documents sharing a long prefix compared equal after the cut")
	}
	if len([]rune(one)) > maxRenderedURL+32 {
		t.Fatalf("the bounded value is still %d characters", len([]rune(one)))
	}
	// And the same document still compares equal to itself across two reads.
	if axIdentityField(prefix+"#one", maxRenderedURL) != one {
		t.Fatal("the same URL produced two different values")
	}
}
