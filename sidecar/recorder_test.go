package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// recorderHarness swaps the platform hook functions for stubs and captures
// what the recorder sends to the brain, so the start/stop/cap state machine
// is tested on every platform.
type recorderHarness struct {
	mu       sync.Mutex
	starts   int
	stops    int
	startErr error
	events   []SidecarEvent
}

func newRecorderHarness(t *testing.T) *recorderHarness {
	t.Helper()
	h := &recorderHarness{}
	prevStart, prevStop := inputHookStart, inputHookStop
	inputHookStart = func() error {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.startErr != nil {
			return h.startErr
		}
		h.starts++
		return nil
	}
	inputHookStop = func() {
		h.mu.Lock()
		h.stops++
		h.mu.Unlock()
	}
	setRecorderSender(context.Background(), func(ctx context.Context, ev SidecarEvent, _ []byte) error {
		h.mu.Lock()
		h.events = append(h.events, ev)
		h.mu.Unlock()
		return nil
	})
	setRecorderIndicator(nil)
	t.Cleanup(func() {
		stopRecording("test")
		inputHookStart, inputHookStop = prevStart, prevStop
		setRecorderSender(context.Background(), nil)
	})
	return h
}

func (h *recorderHarness) counts() (int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.starts, h.stops
}

func (h *recorderHarness) stoppedReasons() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, ev := range h.events {
		if ev.EventType == "ui_recording" {
			if r, _ := ev.Payload["reason"].(string); r != "" {
				out = append(out, r)
			}
		}
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestRecorderStartInstallsHooksAndStopRemovesThem(t *testing.T) {
	h := newRecorderHarness(t)

	res, err := handleRecorderStart(map[string]any{"max_ms": float64(60_000)})
	if err != nil {
		t.Fatal(err)
	}
	m := res.Result.(map[string]any)
	if m["recording"] != true {
		t.Fatalf("expected recording:true, got %v", m)
	}
	if got := m["max_ms"]; got != int64(60_000) {
		t.Fatalf("cap must echo the accepted max_ms, got %v (%T)", got, got)
	}
	if !recorderIsActive() {
		t.Fatal("recorder must be active after start")
	}
	if starts, _ := h.counts(); starts != 1 {
		t.Fatalf("expected one hook install, got %d", starts)
	}

	// A second start while active is a no-op on the hooks.
	if _, err := handleRecorderStart(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if starts, _ := h.counts(); starts != 1 {
		t.Fatalf("second start must not install again, got %d installs", starts)
	}

	if _, err := handleRecorderStop(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if recorderIsActive() {
		t.Fatal("recorder must be inactive after stop")
	}
	if _, stops := h.counts(); stops != 1 {
		t.Fatalf("expected one hook removal, got %d", stops)
	}
	if got := h.stoppedReasons(); len(got) != 1 || got[0] != "rpc" {
		t.Fatalf("brain must hear the stop with reason rpc, got %v", got)
	}

	// Stop when idle is a no-op: no second removal, no second event.
	if _, err := handleRecorderStop(map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if _, stops := h.counts(); stops != 1 {
		t.Fatalf("idle stop must not touch the hooks, got %d removals", stops)
	}
	if got := h.stoppedReasons(); len(got) != 1 {
		t.Fatalf("idle stop must not emit again, got %v", got)
	}
}

func TestRecorderFailedInstallIsAnErrorNotRecordingTrue(t *testing.T) {
	h := newRecorderHarness(t)
	h.startErr = errors.New("SetWindowsHookEx(WH_MOUSE_LL): access denied")

	res, err := handleRecorderStart(map[string]any{})
	if err == nil {
		t.Fatalf("expected an error, got %v", res.Result)
	}
	if recorderIsActive() {
		t.Fatal("a failed install must leave the recorder inactive")
	}
	if got := h.stoppedReasons(); len(got) != 0 {
		t.Fatalf("nothing started, so nothing should report a stop: %v", got)
	}
}

func TestRecorderCapStopsTheHooksWithoutABrainStop(t *testing.T) {
	h := newRecorderHarness(t)

	// max_ms below the floor is clamped up to recorderMinCap; shrink the
	// floor for the test so the cap fires quickly.
	prevMin := recorderMinCap
	defer func() { recorderMinCapOverride(prevMin) }()
	recorderMinCapOverride(20 * time.Millisecond)

	if _, err := handleRecorderStart(map[string]any{"max_ms": float64(20)}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !recorderIsActive() })
	if _, stops := h.counts(); stops != 1 {
		t.Fatalf("cap must remove the hooks exactly once, got %d", stops)
	}
	if got := h.stoppedReasons(); len(got) != 1 || got[0] != "cap" {
		t.Fatalf("brain must hear the cap, got %v", got)
	}
}

func TestRecorderCapIsClamped(t *testing.T) {
	if got := recorderCapFromParams(map[string]any{}); got != recorderDefaultCap {
		t.Fatalf("default cap: got %s", got)
	}
	if got := recorderCapFromParams(map[string]any{"max_ms": float64(1)}); got != recorderMinCap {
		t.Fatalf("below floor must clamp to %s, got %s", recorderMinCap, got)
	}
	if got := recorderCapFromParams(map[string]any{"max_ms": float64(48 * 60 * 60 * 1000)}); got != recorderMaxCap {
		t.Fatalf("above ceiling must clamp to %s, got %s", recorderMaxCap, got)
	}
}
