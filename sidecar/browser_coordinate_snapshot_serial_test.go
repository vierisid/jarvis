package main

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// #826 for the coordinate actions (second security review F-1 on the fix):
// click and hover dispatch at a coordinate copied out of the map, but the
// moved/replaced sentinel in their check reads the isolated world, which a
// concurrent snapshot's script re-arms before its fill moves the generation.
// The sentinel would then judge the new reading's element against the new
// reading's point and pass an element the page had moved off the reviewed
// coordinate. So no snapshot script may reach the browser between the
// sentinel being sent and being answered.
//
// The fake holds the sentinel's reply until a concurrent snapshot's script has
// arrived, or 500ms have shown it cannot arrive while the check is running.
func TestASnapshotCannotRearmTheWorldInsideAClickOrHoverCheck(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(cfg *SidecarConfig) RPCHandler
	}{
		{"click", makeBrowserClickHandler},
		{"hover", makeBrowserHoverHandler},
	} {
		t.Run(tc.name, func(t *testing.T) {
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
						sentinelOnce.Do(func() { close(sentinelSeen) })
						go func(id int64) {
							select {
							case <-snapshotScript:
							case <-time.After(500 * time.Millisecond):
							}
							note("sentinel-answered")
							fb.write(map[string]any{"id": id, "result": map[string]any{
								"result": map[string]any{"type": "string", "value": "ok"},
							}})
						}(cmd.ID)
					default:
						fb.reply(cmd.ID)
					}
				}
			}()

			res, errs := startElementAction(tc.make(guardTestConfig()),
				map[string]any{"element_id": float64(1), "elem_gen": reviewed})
			select {
			case <-sentinelSeen:
			case <-time.After(5 * time.Second):
				t.Fatalf("%s never reached its document-generation check", tc.name)
			}
			snapDone := make(chan error, 1)
			go func() {
				_, _, err := takePageSnapshot(fb.client)
				snapDone <- err
			}()
			select {
			case <-res:
			case err := <-errs:
				t.Fatalf("%s errored: %v", tc.name, err)
			case <-time.After(10 * time.Second):
				t.Fatalf("%s never answered", tc.name)
			}
			select {
			case <-snapDone:
			case <-time.After(10 * time.Second):
				t.Fatal("the snapshot never finished")
			}

			mu.Lock()
			defer mu.Unlock()
			answered, script := -1, -1
			for i, s := range order {
				switch s {
				case "sentinel-answered":
					answered = i
				case "snapshot-script":
					script = i
				}
			}
			if answered < 0 || script < 0 {
				t.Fatalf("order %v is missing a step", order)
			}
			if script < answered {
				t.Fatalf("a snapshot re-armed the world while the %s's moved/replaced check was running (order %v)", tc.name, order)
			}
		})
	}
}
