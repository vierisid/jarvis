package main

import (
	"strings"
	"testing"
	"time"
)

// A holder that never lets go -- a renderer that stopped answering mid-snapshot
// -- must not park every later snapshot and reviewed type behind it for a
// 30-second send each (security review SEC-004 on #826). The waiter refuses
// legibly once the bound passes, and sends the browser nothing.
func TestASnapshotWaitingBehindAStuckOneRefusesInsteadOfQueueing(t *testing.T) {
	fb := newTypeFixture(t)
	previous := snapshotLockTimeout
	snapshotLockTimeout = 200 * time.Millisecond
	t.Cleanup(func() { snapshotLockTimeout = previous })
	fb.client.snapMu.Lock()
	t.Cleanup(fb.client.snapMu.Unlock)

	for name, run := range map[string]func() error{
		"snapshot": func() error { _, _, err := takePageSnapshot(fb.client); return err },
		"type": func() error {
			_, err := makeBrowserTypeHandler(guardTestConfig())(map[string]any{
				"element_id": float64(1), "text": "x", "elem_gen": currentElemGen(fb.client)})
			return err
		},
	} {
		done := make(chan error, 1)
		started := time.Now()
		go func() { done <- run() }()
		select {
		case err := <-done:
			if err == nil || !strings.Contains(err.Error(), "still running on this browser") {
				t.Fatalf("%s behind a stuck holder returned %v, want the in-progress refusal", name, err)
			}
			if waited := time.Since(started); waited > 2*time.Second {
				t.Fatalf("%s waited %v, far past the bound", name, waited)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s queued behind a stuck holder instead of refusing", name)
		}
	}
	// Once, after both: noCommandWithin leaves its reader goroutine parked on
	// the pipe, so a second call would race the first one's reader.
	fb.noCommandWithin(200 * time.Millisecond)
}

// #1161: navigate's closing snapshot meeting the lock timeout reported the
// generic "so nothing was done", though Page.navigate had already been sent
// and the page had moved. It says what happened instead, in the local
// browser's words (src/actions/browser/session.ts NAVIGATED_SNAPSHOT_LOCK_BUSY).
func TestNavigateWhoseSnapshotMeetsTheLockTimeoutSaysTheNavigationStarted(t *testing.T) {
	fb := newTypeFixture(t)
	previous := snapshotLockTimeout
	snapshotLockTimeout = 200 * time.Millisecond
	t.Cleanup(func() { snapshotLockTimeout = previous })
	fb.client.snapMu.Lock()
	t.Cleanup(fb.client.snapMu.Unlock)

	done := make(chan error, 1)
	go func() {
		_, err := makeBrowserNavigateHandler(guardTestConfig())(map[string]any{"url": "https://example.com/next"})
		done <- err
	}()
	c := fb.nextCommand()
	if c.Method != "Page.navigate" {
		t.Fatalf("first command = %q, want Page.navigate", c.Method)
	}
	fb.reply(c.ID)
	fb.write(map[string]any{"method": "Page.loadEventFired", "params": map[string]any{}})

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("navigate succeeded with the snapshot lock held")
		}
		if strings.Contains(err.Error(), "nothing was done") {
			t.Fatalf("navigate reported %q: false, the navigation was sent", err)
		}
		if err.Error() != navigatedSnapshotLockBusy {
			t.Fatalf("navigate error = %q, want %q", err, navigatedSnapshotLockBusy)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("navigate never answered")
	}
}
