package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func hasFileEvent(events []map[string]any, path, kind string) bool {
	for _, e := range events {
		if e["path"] == path && e["eventType"] == kind {
			return true
		}
	}
	return false
}

func TestFileObserverDetectsLifecycle(t *testing.T) {
	dir := t.TempDir()
	obs := NewFileObserver([]string{dir}, nil, 1000)

	// Seed baseline (no events emitted for the seed).
	obs.mu.Lock()
	obs.known = obs.scan()
	obs.mu.Unlock()

	var mu sync.Mutex
	var events []map[string]any
	send := func(_ context.Context, e SidecarEvent, _ []byte) error {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, e.Payload)
		return nil
	}
	reset := func() {
		mu.Lock()
		events = nil
		mu.Unlock()
	}
	snapshot := func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), events...)
	}

	file := filepath.Join(dir, "note.txt")

	// created
	if err := os.WriteFile(file, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	obs.poll(context.Background(), send)
	if !hasFileEvent(snapshot(), file, "created") {
		t.Fatalf("expected created event for %s, got %+v", file, snapshot())
	}

	// modified — bump mtime explicitly so the change is detectable regardless
	// of filesystem timestamp resolution.
	reset()
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(file, future, future); err != nil {
		t.Fatal(err)
	}
	obs.poll(context.Background(), send)
	if !hasFileEvent(snapshot(), file, "modified") {
		t.Fatalf("expected modified event for %s, got %+v", file, snapshot())
	}

	// deleted
	reset()
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	obs.poll(context.Background(), send)
	if !hasFileEvent(snapshot(), file, "deleted") {
		t.Fatalf("expected deleted event for %s, got %+v", file, snapshot())
	}
}

func TestFileObserverExcludedPrefix(t *testing.T) {
	base := filepath.Join("home", "u")
	excl := filepath.Join(base, "data")
	obs := NewFileObserver([]string{base}, []string{excl}, 1000)
	sep := string(os.PathSeparator)

	cases := map[string]bool{
		excl:                         true,  // the excluded dir itself
		excl + sep + "x.txt":         true,  // a file under it
		excl + sep + "sub":           true,  // a subdir under it
		excl + "2":                   false, // sibling sharing the prefix
		excl + "-backup":             false, // sibling sharing the prefix
		filepath.Join(base, "other"): false,
	}
	for p, want := range cases {
		if got := obs.excluded(p); got != want {
			t.Errorf("excluded(%q) = %v, want %v", p, got, want)
		}
	}
}

func TestFileObserverExcludesPaths(t *testing.T) {
	dir := t.TempDir()
	excluded := filepath.Join(dir, ".jarvis")
	if err := os.MkdirAll(excluded, 0o755); err != nil {
		t.Fatal(err)
	}
	obs := NewFileObserver([]string{dir}, []string{excluded}, 1000)

	obs.mu.Lock()
	obs.known = obs.scan()
	obs.mu.Unlock()

	var events []map[string]any
	send := func(_ context.Context, e SidecarEvent, _ []byte) error {
		events = append(events, e.Payload)
		return nil
	}

	// A file under the excluded prefix must not produce an event.
	if err := os.WriteFile(filepath.Join(excluded, "capture.png"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A file outside it must.
	visible := filepath.Join(dir, "doc.md")
	if err := os.WriteFile(visible, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	obs.poll(context.Background(), send)

	if hasFileEvent(events, filepath.Join(excluded, "capture.png"), "created") {
		t.Fatalf("excluded path leaked an event: %+v", events)
	}
	if !hasFileEvent(events, visible, "created") {
		t.Fatalf("expected event for visible file, got %+v", events)
	}
}
