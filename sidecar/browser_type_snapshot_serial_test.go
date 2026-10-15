package main

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// #826, the action half (security review SEC-001 on the fix): serialising two
// snapshots is not enough on its own. browser_type checks the generation in
// refuseStaleElement and THEN acts through the isolated world's refs, so a
// snapshot whose script runs between the check and the focus re-arms the refs
// under the type's feet: the generation still matches (that snapshot has not
// filled yet), the focus script focuses the NEW snapshot's element at that
// index, both focus re-checks read the same new refs and pass, and the
// reviewed text is inserted into an element nobody reviewed.
//
// The fake answers everything a browser would and records the order the
// commands reached it in. It holds the type's document-generation sentinel
// until a concurrent snapshot's script has arrived, or 500ms have shown that
// it cannot arrive while the type is in flight.

func TestASnapshotCannotRearmTheRefsInsideABrowserType(t *testing.T) {
	fb := newTypeFixture(t)
	reviewed := currentElemGen(fb.client)

	var mu sync.Mutex
	var order []string
	note := func(s string) {
		mu.Lock()
		order = append(order, s)
		mu.Unlock()
	}
	sentinelSeen := make(chan struct{})
	snapshotScript := make(chan struct{})
	var sentinelOnce, scriptOnce sync.Once

	go func() {
		for {
			data, err := fb.fromCmd.ReadBytes(0)
			if err != nil {
				return
			}
			var cmd cdpCommand
			if json.Unmarshal([]byte(strings.TrimSuffix(string(data), "\x00")), &cmd) != nil {
				return
			}
			expr, _ := cmd.Params["expression"].(string)
			switch {
			case cmd.Method == "Page.getFrameTree":
				fb.frameTreeReplyFull(cmd.ID, "https://app.example.com/", "L1", "https://app.example.com")
			case cmd.Method == "Runtime.evaluate" && strings.Contains(expr, "globalThis.__jarvis_elements = els"):
				note("snapshot-script")
				scriptOnce.Do(func() { close(snapshotScript) })
				fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{
					"result": map[string]any{"value": snapshotReplyFor(500, 500)},
				}})
			case cmd.Method == "Runtime.evaluate" && strings.Contains(expr, "__jarvis_dom"):
				note("type-sentinel")
				sentinelOnce.Do(func() { close(sentinelSeen) })
				go func(id int64) {
					select {
					case <-snapshotScript:
					case <-time.After(500 * time.Millisecond):
					}
					fb.write(map[string]any{"id": id, "result": map[string]any{
						"result": map[string]any{"type": "string", "value": "ok"},
					}})
				}(cmd.ID)
			case cmd.Method == "Runtime.evaluate":
				note("type-focus")
				fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{
					"result": map[string]any{"type": "string", "value": "ok"},
				}})
			case cmd.Method == "Input.insertText":
				note("type-insert")
				fb.reply(cmd.ID)
			default:
				fb.reply(cmd.ID)
			}
		}
	}()

	res, errs := startElementAction(makeBrowserTypeHandler(guardTestConfig()),
		map[string]any{"element_id": float64(1), "text": "approved text", "elem_gen": reviewed})
	select {
	case <-sentinelSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("the type never reached its document-generation check")
	}
	// Another reader snapshots the same browser while the type is in flight.
	snapDone := make(chan error, 1)
	go func() {
		_, _, err := takePageSnapshot(fb.client)
		snapDone <- err
	}()

	select {
	case <-res:
	case err := <-errs:
		t.Fatalf("the type errored: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the type never answered")
	}
	select {
	case <-snapDone:
	case <-time.After(10 * time.Second):
		t.Fatal("the snapshot never finished")
	}

	mu.Lock()
	defer mu.Unlock()
	sentinel, insert, script := -1, -1, -1
	lastFocus := -1
	for i, s := range order {
		switch s {
		case "type-sentinel":
			sentinel = i
		case "type-insert":
			insert = i
		case "type-focus":
			lastFocus = i
		case "snapshot-script":
			script = i
		}
	}
	if sentinel < 0 || insert < 0 || script < 0 {
		t.Fatalf("command order %v is missing a step", order)
	}
	// The refs the type acted through must be the ones its check approved:
	// no snapshot script may run between the check and the last focus verify.
	if script > sentinel && script < lastFocus {
		t.Fatalf("a snapshot re-armed the element refs in the middle of a reviewed type (order %v): "+
			"the text went to whatever that snapshot put at the reviewed index", order)
	}
}
