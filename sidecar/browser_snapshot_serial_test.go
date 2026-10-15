package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// #826: two snapshots of the same document in flight at once must not leave
// the coordinate map, the generation and the isolated world's refs describing
// different readings.
//
// The snapshot script ARMS the world's refs when the browser runs it, while the
// map fill and the generation bump happen later, back in Go. Each RPC runs on
// its own goroutine, so with nothing ordering them the browser can run A's
// script, then B's, while the fills land B then A:
//
//	A-evaluate, B-evaluate, B-fill, A-fill
//
// The map then holds A's coordinates under A's generation, and the world holds
// B's refs. A browser_type reviewed against A's snapshot passes the #676
// generation compare and types into B's element at that index.
//
// Over the fake CDP pipe, which is the right instrument for an ordering bug:
// the fake answers each command the way a browser would, records which
// snapshot's script ran LAST (that is what the world holds), and holds A's
// script reply back until B's has either run or plainly cannot -- forcing
// exactly the interleaving above whenever the code allows it.

// snapshotReplyFor is a snapshot script reply with one element at (x, y).
func snapshotReplyFor(x, y int) string {
	return fmt.Sprintf(`{"title":"App","url":"https://app.example.com/","text":"hi",`+
		`"elements":[{"id":1,"tag":"input","text":"","attrs":{},"x":%d,"y":%d}]}`, x, y)
}

// interleavingBrowser answers the fake pipe for two concurrent snapshots.
type interleavingBrowser struct {
	fb *fakeBrowser

	mu sync.Mutex
	// evaluates counts snapshot scripts the browser has RUN, in arrival order.
	evaluates int
	// armedBy is the snapshot ("A" or "B") whose script ran last, i.e. whose
	// refs the isolated world holds now.
	armedBy string
	// secondEvaluate closes when B's script arrives.
	secondEvaluate chan struct{}
	// firstEvaluate closes when A's script arrives.
	firstEvaluate chan struct{}
	// releaseA closes when A's script may be answered.
	releaseA chan struct{}
}

func (ib *interleavingBrowser) serve(stop <-chan struct{}) {
	for {
		data, err := ib.fb.fromCmd.ReadBytes(0)
		if err != nil {
			return
		}
		var cmd cdpCommand
		if json.Unmarshal([]byte(strings.TrimSuffix(string(data), "\x00")), &cmd) != nil {
			return
		}
		select {
		case <-stop:
			return
		default:
		}
		switch cmd.Method {
		case "Page.getFrameTree":
			ib.fb.frameTreeReplyFull(cmd.ID, "https://app.example.com/", "L1", "https://app.example.com")
		case "Runtime.evaluate":
			if expr, _ := cmd.Params["expression"].(string); !strings.Contains(expr, "globalThis.__jarvis_elements = els") {
				// Not the snapshot script: an action's sentinel or focus
				// check, which a real world holding the refs answers "ok".
				ib.fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{
					"result": map[string]any{"type": "string", "value": "ok"},
				}})
				continue
			}
			ib.mu.Lock()
			ib.evaluates++
			n := ib.evaluates
			if n == 1 {
				ib.armedBy = "A"
			} else {
				ib.armedBy = "B"
			}
			ib.mu.Unlock()
			if n == 1 {
				close(ib.firstEvaluate)
				// A's reply is held until the test releases it, in its own
				// goroutine so B's commands keep being answered meanwhile.
				go func(id int64) {
					<-ib.releaseA
					ib.fb.write(map[string]any{"id": id, "result": map[string]any{
						"result": map[string]any{"value": snapshotReplyFor(100, 100)},
					}})
				}(cmd.ID)
				continue
			}
			close(ib.secondEvaluate)
			ib.fb.write(map[string]any{"id": cmd.ID, "result": map[string]any{
				"result": map[string]any{"value": snapshotReplyFor(500, 500)},
			}})
		default:
			ib.fb.reply(cmd.ID)
		}
	}
}

func TestConcurrentSnapshotsLeaveTheMapAndTheWorldOnOneReading(t *testing.T) {
	fb := newFakeBrowser(t)
	// A world is already cached for this document, so neither snapshot mints
	// one: the situation where both scripts arm the SAME world.
	fb.client.worldLoaderID = "L1"
	fb.client.worldContext = isolatedWorldContextID

	ib := &interleavingBrowser{
		fb:             fb,
		secondEvaluate: make(chan struct{}),
		firstEvaluate:  make(chan struct{}),
		releaseA:       make(chan struct{}),
	}
	stop := make(chan struct{})
	defer close(stop)
	go ib.serve(stop)

	type outcome struct {
		snap *pageSnapshot
		err  error
	}
	aDone := make(chan outcome, 1)
	bDone := make(chan outcome, 1)

	go func() {
		s, _, err := takePageSnapshot(fb.client)
		aDone <- outcome{s, err}
	}()
	select {
	case <-ib.firstEvaluate:
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot A never ran its script")
	}

	go func() {
		s, _, err := takePageSnapshot(fb.client)
		bDone <- outcome{s, err}
	}()

	// Force B-evaluate and B-fill BEFORE A's reply whenever the code lets B
	// get that far. If B cannot even run its script while A is in flight, the
	// interleaving is impossible and A is released after a bounded wait.
	var b outcome
	bFinishedFirst := false
	select {
	case <-ib.secondEvaluate:
		select {
		case b = <-bDone:
			bFinishedFirst = true
		case <-time.After(5 * time.Second):
			t.Fatal("snapshot B ran its script but never finished")
		}
	case <-time.After(500 * time.Millisecond):
	}
	close(ib.releaseA)

	var a outcome
	select {
	case a = <-aDone:
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot A never finished")
	}
	if !bFinishedFirst {
		select {
		case b = <-bDone:
		case <-time.After(5 * time.Second):
			t.Fatal("snapshot B never finished")
		}
	}
	if a.err != nil || b.err != nil {
		t.Fatalf("snapshots errored: A=%v B=%v", a.err, b.err)
	}

	ib.mu.Lock()
	armedBy := ib.armedBy
	ib.mu.Unlock()

	el, ok := fb.client.snapshotElementFor(1)
	if !ok {
		t.Fatal("no element 1 in the map after two successful snapshots")
	}
	var live *pageSnapshot
	switch el.token {
	case a.snap.gen:
		live = a.snap
	case b.snap.gen:
		live = b.snap
	default:
		t.Fatalf("the map's generation %q is neither snapshot's (A %q, B %q)", el.token, a.snap.gen, b.snap.gen)
	}
	liveName := "A"
	if live == b.snap {
		liveName = "B"
	}

	// The binding a reviewed action relies on: the snapshot whose generation
	// the map is on is the one whose refs the world holds. Under the bug the
	// map is on A's generation and coordinates while the world holds B's refs,
	// so a browser_type reviewed against A passes every check and types into
	// B's element.
	if liveName != armedBy {
		t.Errorf("the map is on snapshot %s's generation %q and coordinates (%v,%v), but the isolated "+
			"world holds snapshot %s's refs: a type reviewed against %s would act on %s's element",
			liveName, el.token, el.x, el.y, armedBy, liveName, armedBy)
	}
	wantX := float64(live.Elements[0].X)
	if el.x != wantX {
		t.Fatalf("the map's coordinate x=%v is not the live snapshot's own x=%v", el.x, wantX)
	}

	// And end to end, through the real handler: a type reviewed against the
	// snapshot whose refs the world does NOT hold must be refused as
	// superseded, before it focuses anything.
	stale := a.snap
	if armedBy == "A" {
		stale = b.snap
	}
	useFakeBrowserAsActiveCDP(t, fb.client)
	res, errs := startElementAction(makeBrowserTypeHandler(guardTestConfig()),
		map[string]any{"element_id": float64(1), "text": "approved text", "elem_gen": stale.gen})
	select {
	case err := <-errs:
		if !strings.Contains(err.Error(), "reviewed against a browser snapshot that has since been replaced") {
			t.Fatalf("type on the stale snapshot errored with %v, want the superseded refusal", err)
		}
	case r := <-res:
		t.Fatalf("a type reviewed against a snapshot whose refs the world does not hold answered %v, "+
			"want it refused as superseded", r.Result)
	case <-time.After(10 * time.Second):
		t.Fatal("the type handler never answered")
	}
}
