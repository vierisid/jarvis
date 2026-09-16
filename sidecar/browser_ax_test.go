package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// axv builds the { value: ... } wrapper CDP uses for AX node fields.
func axv(s string) *axValue {
	raw, _ := json.Marshal(s)
	return &axValue{Value: raw}
}

func axChild(id, parent, role, name string, backend int64) axNode {
	return axNode{
		NodeID:           id,
		ParentID:         parent,
		Role:             axv(role),
		Name:             axv(name),
		BackendDOMNodeID: backend,
	}
}

func elemNames(els []map[string]any) []string {
	out := make([]string, 0, len(els))
	for _, e := range els {
		out = append(out, e["name"].(string))
	}
	return out
}

func TestBuildAXElementsDropsUnaddressableNodes(t *testing.T) {
	nodes := []axNode{
		axChild("1", "", "RootWebArea", "Gmail", 1),
		// AX-only wrapper Gmail puts next to the real field: no DOM node, so
		// click/set_value/getBoxModel can never act on it.
		axChild("2", "1", "textbox", "To", 0),
		axChild("3", "1", "textbox", "To", 42),
	}
	els := buildAXElements(nodes)
	for _, e := range els {
		if e["backend_node_id"].(int64) == 0 {
			t.Fatalf("emitted a node with no backing DOM node: %v", e)
		}
	}
	if len(els) != 2 {
		t.Fatalf("expected root + the addressable textbox, got %v", elemNames(els))
	}
}

func TestBuildAXElementsSkipsIgnoredAndUnnamedWrappers(t *testing.T) {
	nodes := []axNode{
		axChild("1", "", "RootWebArea", "Page", 1),
		axChild("2", "1", "generic", "", 2),      // unnamed wrapper: no value
		axChild("3", "1", "StaticText", "", 3),   // unnamed text: nothing to read
		axChild("4", "1", "button", "", 4),       // unnamed but actionable: keep
		axChild("5", "1", "StaticText", "Hi", 5), // named text: context
	}
	var ignored = axNode{NodeID: "6", ParentID: "1", Role: axv("button"), Name: axv("Gone"), BackendDOMNodeID: 6, Ignored: true}
	nodes = append(nodes, ignored)

	els := buildAXElements(nodes)
	got := map[string]bool{}
	for _, e := range els {
		got[e["role"].(string)+"/"+e["name"].(string)] = true
	}
	if got["generic/"] || got["StaticText/"] {
		t.Fatalf("emitted an unnamed wrapper: %v", got)
	}
	if !got["button/"] {
		t.Fatal("dropped an unnamed but interactive element")
	}
	if !got["StaticText/Hi"] {
		t.Fatal("dropped named text context")
	}
	if got["button/Gone"] {
		t.Fatal("emitted an AX-ignored node")
	}
}

func TestBuildAXElementsNeverTruncatesInteractiveElements(t *testing.T) {
	// A Gmail-sized page: far more static text than the cap, with the compose
	// fields sitting after it in tree order. Capping in raw order would drop
	// exactly the elements the agent needs.
	nodes := []axNode{axChild("root", "", "RootWebArea", "Inbox", 1)}
	for i := 0; i < axMaxElements*2; i++ {
		nodes = append(nodes, axChild(fmt.Sprintf("t%d", i), "root", "StaticText", fmt.Sprintf("row %d", i), int64(100+i)))
	}
	nodes = append(nodes,
		axChild("to", "root", "textbox", "To", 9001),
		axChild("subj", "root", "textbox", "Subject", 9002),
	)

	els := buildAXElements(nodes)

	seen := map[string]bool{}
	interactive := 0
	for _, e := range els {
		seen[e["name"].(string)] = true
		if e["interactive"].(bool) {
			interactive++
		}
	}
	if !seen["To"] || !seen["Subject"] {
		t.Fatalf("cap truncated the actionable fields (kept %d elements, %d interactive)", len(els), interactive)
	}
	if len(els) != axMaxElements {
		t.Fatalf("expected the static-text context capped to %d elements, got %d", axMaxElements, len(els))
	}
}

func TestBuildAXElementsKeepsInteractiveElementsPastTheCap(t *testing.T) {
	// More actionable controls than the cap: the cap bounds context, never
	// targets, so every one of them still has to come back.
	nodes := []axNode{axChild("root", "", "RootWebArea", "App", 1)}
	for i := 0; i < axMaxElements+50; i++ {
		nodes = append(nodes, axChild(fmt.Sprintf("b%d", i), "root", "button", fmt.Sprintf("act %d", i), int64(200+i)))
	}
	nodes = append(nodes, axChild("note", "root", "StaticText", "footer", 9999))

	els := buildAXElements(nodes)
	interactive := 0
	for _, e := range els {
		if e["interactive"].(bool) {
			interactive++
		}
	}
	if interactive != axMaxElements+50 {
		t.Fatalf("lost interactive elements to the cap: kept %d of %d", interactive, axMaxElements+50)
	}
	if len(els) != interactive {
		t.Fatalf("context should have no budget left, got %d extra", len(els)-interactive)
	}
}

func TestBuildAXElementsRefsAreStableAndDisambiguated(t *testing.T) {
	nodes := []axNode{
		axChild("root", "", "RootWebArea", "Inbox", 1),
		axChild("list", "root", "list", "Messages", 2),
		axChild("a", "list", "button", "Open", 3),
		axChild("b", "list", "button", "Open", 4),
	}

	els := buildAXElements(nodes)
	bySig := map[string]map[string]any{}
	var opens []map[string]any
	for _, e := range els {
		sig := e["sig"].(string)
		if sig == "" {
			t.Fatalf("element emitted without a sig: %v", e)
		}
		if prev, dup := bySig[sig]; dup {
			t.Fatalf("two elements share a sig: %v and %v", prev, e)
		}
		bySig[sig] = e
		if e["name"] == "Open" {
			opens = append(opens, e)
		}
	}
	if len(opens) != 2 {
		t.Fatalf("expected both Open buttons, got %d", len(opens))
	}
	if opens[0]["ordinal"].(int) == opens[1]["ordinal"].(int) {
		t.Fatal("same-role+name siblings must get distinct ordinals")
	}
	// The path is the ancestry the resolver re-matches on.
	path := opens[0]["path"].([]map[string]any)
	if len(path) == 0 || path[len(path)-1]["role"] != "list" {
		t.Fatalf("expected the immediate container last in the path, got %v", path)
	}

	// A second snapshot of the same tree must produce the same addresses --
	// that is the whole point of a durable ref.
	again := buildAXElements(nodes)
	for i := range els {
		if els[i]["sig"] != again[i]["sig"] {
			t.Fatalf("sig is not deterministic for element %d", i)
		}
	}
}

func TestBuildAXElementsToleratesMissingPropertyValues(t *testing.T) {
	n := axChild("1", "", "button", "Send", 7)
	n.Properties = []axProp{
		{Name: "disabled"},                   // CDP field absent: must not panic
		{Name: "focused", Value: &axValue{}}, // present but empty
		{Name: "checked", Value: axv("true")},
	}
	els := buildAXElements([]axNode{n})
	if len(els) != 1 {
		t.Fatalf("expected one element, got %d", len(els))
	}
	if _, ok := els[0]["disabled"]; ok {
		t.Fatal("a property with no value must be omitted, not emitted as null")
	}
	if els[0]["checked"] == nil {
		t.Fatal("a property with a value must be carried through")
	}
}

// replyWith stands in for readLoop: it answers whatever command is in flight
// with a canned CDP result, so a handler's parsing can be tested without a
// real browser (same approach as the browser-readiness tests).
func replyWith(c *cdpClient, result string) func() {
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
			}
			c.pendMu.Lock()
			for id, ch := range c.pending {
				delete(c.pending, id)
				ch <- cdpReply{result: []byte(result)}
			}
			c.pendMu.Unlock()
			time.Sleep(time.Millisecond)
		}
	}()
	return func() { close(done) }
}

func TestEvalJSONParsesAPageObject(t *testing.T) {
	c := newTestClient(&blackholeWriter{})
	stop := replyWith(c, `{"result":{"type":"string","value":"{\"url\":\"https://mail.example/inbox\",\"title\":\"Inbox\"}"}}`)
	defer stop()

	got, err := c.evalJSON(`JSON.stringify({url: location.href, title: document.title})`)
	if err != nil {
		t.Fatalf("expected a parsed object, got error: %v", err)
	}
	if got["url"] != "https://mail.example/inbox" || got["title"] != "Inbox" {
		t.Fatalf("unexpected page info: %v", got)
	}
}

// A script that threw must surface as an error. Swallowing it is how a
// snapshot ends up reporting elements while claiming a url it never read.
func TestEvalJSONSurfacesPageExceptions(t *testing.T) {
	c := newTestClient(&blackholeWriter{})
	stop := replyWith(c, `{"result":{"type":"undefined"},"exceptionDetails":{"text":"Uncaught","exception":{"description":"TypeError: nope"}}}`)
	defer stop()

	got, err := c.evalJSON(`JSON.stringify({url: location.href})`)
	if err == nil {
		t.Fatalf("a page exception must be an error, got %v", got)
	}
	if !strings.Contains(err.Error(), "TypeError: nope") {
		t.Errorf("error should name the page-side cause, got: %v", err)
	}
}

// A reply that is not a JSON object (undefined, a bare number) is an error
// too -- returning an empty map would read as "the page had no url".
func TestEvalJSONRejectsNonObjectResults(t *testing.T) {
	c := newTestClient(&blackholeWriter{})
	stop := replyWith(c, `{"result":{"type":"undefined"}}`)
	defer stop()

	if _, err := c.evalJSON(`undefined`); err == nil {
		t.Fatal("expected an error for a non-object result")
	}
}
