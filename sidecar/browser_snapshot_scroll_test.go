package main

import (
	"strings"
	"testing"
	"time"
)

// #878. forgetSnapshotElements (a scroll, a paging key, ax_click's
// scrollIntoViewIfNeeded) deliberately does not take snapMu, so it can run
// while a snapshot is in flight. When it lands between the snapshot's script
// and its fill, the script measured the page at a position the forget says is
// gone, yet the fill installed those coordinates under a fresh generation and
// reinstated the document identity the forget had cleared. Every reader then
// took them as current: browser_element_point (which deliberately skips the
// live-position sentinel) handed the pebble a pre-scroll point.
//
// Driven over the fake CDP pipe with the forget placed at an exact step, which
// is the instrument for an ordering bug: the race detector reports nothing
// here, because every access is under elemMu.

// snapshotWithForgetAt runs one snapshot and calls forgetSnapshotElements, the
// way browser_scroll does, right after the command named `at` arrives and
// before it is answered.
func snapshotWithForgetAt(t *testing.T, at string) (*pageSnapshot, error, *fakeBrowser) {
	t.Helper()
	fb := newFakeBrowser(t)
	type outcome struct {
		snap *pageSnapshot
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		snap, _, err := takePageSnapshot(fb.client)
		done <- outcome{snap, err}
	}()

	frameTree := fb.nextCommand()
	if frameTree.Method != "Page.getFrameTree" {
		t.Fatalf("first command = %q, want Page.getFrameTree", frameTree.Method)
	}
	if at == "Page.getFrameTree" {
		fb.client.forgetSnapshotElements()
	}
	fb.frameTreeReply(frameTree.ID, "https://example.com/")

	world := fb.nextCommand()
	if world.Method != "Page.createIsolatedWorld" {
		t.Fatalf("second command = %q, want Page.createIsolatedWorld", world.Method)
	}
	forgot := make(chan struct{})
	if at == "Page.createIsolatedWorld" {
		// The mint holds worldMu across its round trip and the forget takes
		// it after bumping the generation, so the forget runs on its own
		// goroutine: it bumps the generation now and clears the world the
		// moment the mint lets go, which is the order production sees.
		before := elemGenOf(fb.client)
		go func() {
			defer close(forgot)
			fb.client.forgetSnapshotElements()
		}()
		deadline := time.Now().Add(5 * time.Second)
		for elemGenOf(fb.client) == before {
			if time.Now().After(deadline) {
				t.Fatal("the forget never bumped the generation")
			}
			time.Sleep(time.Millisecond)
		}
	} else {
		close(forgot)
	}
	fb.write(map[string]any{"id": world.ID, "result": map[string]any{"executionContextId": isolatedWorldContextID}})

	script := fb.nextCommand()
	if script.Method != "Runtime.evaluate" {
		t.Fatalf("third command = %q, want the snapshot script", script.Method)
	}
	if at == "Runtime.evaluate" {
		fb.client.forgetSnapshotElements()
	}
	fb.write(map[string]any{"id": script.ID, "result": map[string]any{"result": map[string]any{
		"type": "string",
		"value": `{"title":"Example","url":"https://example.com/","text":"hello",` +
			`"elements":[{"id":1,"tag":"button","text":"Go","attrs":{},"x":10,"y":20}]}`,
	}}})

	// The re-check of the document. Every path through the real code asks for
	// it, refusal or not, because the generation is compared in the fill's
	// critical section, after the re-check.
	recheckCmd := fb.nextCommand()
	if recheckCmd.Method != "Page.getFrameTree" {
		t.Fatalf("fourth command = %q, want the Page.getFrameTree re-check", recheckCmd.Method)
	}
	if at == "recheck" {
		fb.client.forgetSnapshotElements()
	}
	fb.frameTreeReply(recheckCmd.ID, "https://example.com/")

	<-forgot
	select {
	case got := <-done:
		return got.snap, got.err, fb
	case <-time.After(5 * time.Second):
		t.Fatal("takePageSnapshot never returned")
		return nil, nil, fb
	}
}

// The case the issue is about: the forget lands while the script is running.
// The snapshot must fail rather than fill, and leave the map as the forget
// left it, so element_point has nothing to answer with.
func TestSnapshotRefusesWhenAScrollLandsDuringItsScript(t *testing.T) {
	snap, err, fb := snapshotWithForgetAt(t, "Runtime.evaluate")
	if err == nil {
		t.Fatalf("snapshot returned with the page moved under it: %+v", snap)
	}
	if !strings.Contains(err.Error(), "moved while the snapshot was being taken") {
		t.Fatalf("refusal %q does not say the page moved", err)
	}
	if el, ok := fb.client.snapshotElementFor(1); ok {
		t.Fatalf("element 1 is in the map at the pre-scroll point (%v, %v) after the scroll forgot it", el.x, el.y)
	}
	fb.client.worldMu.Lock()
	ctx := fb.client.worldContext
	fb.client.worldMu.Unlock()
	if ctx != 0 {
		t.Errorf("the isolated world is still cached (context %v) after a refused snapshot", ctx)
	}
}

// A forget during the re-check of the document, after the script and before
// the fill. Pins the compare to after the re-check: a check made before it
// cannot see this one. (That it sits inside the fill's elemMu section, with no
// gap before the write, is not observable without a hook.)
func TestSnapshotRefusesWhenAScrollLandsDuringItsRecheck(t *testing.T) {
	_, err, fb := snapshotWithForgetAt(t, "recheck")
	if err == nil || !strings.Contains(err.Error(), "moved while the snapshot was being taken") {
		t.Fatalf("snapshot err = %v, want a refusal saying the page moved", err)
	}
	if _, ok := fb.client.snapshotElementFor(1); ok {
		t.Fatal("element 1 is in the map after a scroll forgot it mid-snapshot")
	}
}

// Before the script was even sent, the world it runs in was being minted; a
// forget then clears that world in Go while the browser still has it. Same
// answer: the reading cannot be trusted to describe the page after the move.
func TestSnapshotRefusesWhenAScrollLandsWhileItsWorldIsMinted(t *testing.T) {
	_, err, fb := snapshotWithForgetAt(t, "Page.createIsolatedWorld")
	if err == nil || !strings.Contains(err.Error(), "moved while the snapshot was being taken") {
		t.Fatalf("snapshot err = %v, want a refusal saying the page moved", err)
	}
	if _, ok := fb.client.snapshotElementFor(1); ok {
		t.Fatal("element 1 is in the map after a scroll forgot it mid-snapshot")
	}
}

// Control, so the two above are not passing on a snapshot that always fails:
// with no forget at all the same script fills the map.
func TestSnapshotWithNoScrollFillsTheMap(t *testing.T) {
	_, err, fb := snapshotWithForgetAt(t, "")
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if el, ok := fb.client.snapshotElementFor(1); !ok || el.x != 10 || el.y != 20 {
		t.Fatalf("element 1 = %+v, %v; want it at (10, 20)", el, ok)
	}
}

// A forget that lands BEFORE the world is minted is not a race at all: the
// script has not run, so it measures the page after the move, and the world
// it arms is the one the fill pairs with. Refusing it would fail snapshots for
// nothing.
func TestSnapshotAfterAScrollThatLandedBeforeItsWorldFillsTheMap(t *testing.T) {
	_, err, fb := snapshotWithForgetAt(t, "Page.getFrameTree")
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if el, ok := fb.client.snapshotElementFor(1); !ok || el.x != 10 || el.y != 20 {
		t.Fatalf("element 1 = %+v, %v; want it at (10, 20)", el, ok)
	}
}

func elemGenOf(c *cdpClient) uint64 {
	c.elemMu.Lock()
	defer c.elemMu.Unlock()
	return c.elemGen
}
