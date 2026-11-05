package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// #1159: with awareness or desktop control off the brain drops what the screen
// observers send, but the sidecar kept screenshotting, saving and OCRing every
// tick, and reading the clipboard. observers.set_paused stops them at the
// source; these pin that a paused observer does not touch the platform at all.

func pauseObservers(t *testing.T, screen, clipboard bool) {
	t.Helper()
	prevS, prevC := screenObserversPaused.Load(), clipboardObserverPaused.Load()
	t.Cleanup(func() {
		screenObserversPaused.Store(prevS)
		clipboardObserverPaused.Store(prevC)
	})
	screenObserversPaused.Store(screen)
	clipboardObserverPaused.Store(clipboard)
}

func TestObserversSetPausedHandler(t *testing.T) {
	pauseObservers(t, false, false)
	h := makeObserversSetPausedHandler()
	res, err := h(map[string]any{"screen": true, "clipboard": false})
	if err != nil {
		t.Fatal(err)
	}
	if !screenObserversPaused.Load() || clipboardObserverPaused.Load() {
		t.Fatalf("after {screen:true, clipboard:false}: screen=%v clipboard=%v", screenObserversPaused.Load(), clipboardObserverPaused.Load())
	}
	if m := res.Result.(map[string]any); m["screen"] != true || m["clipboard"] != false {
		t.Errorf("result = %v", m)
	}
	// An absent or malformed key leaves that observer alone.
	if _, err := h(map[string]any{"clipboard": true, "screen": "yes"}); err != nil {
		t.Fatal(err)
	}
	if !screenObserversPaused.Load() || !clipboardObserverPaused.Load() {
		t.Fatalf("after {clipboard:true}: screen=%v clipboard=%v", screenObserversPaused.Load(), clipboardObserverPaused.Load())
	}
	if _, err := h(map[string]any{"screen": false, "clipboard": false}); err != nil {
		t.Fatal(err)
	}
	if screenObserversPaused.Load() || clipboardObserverPaused.Load() {
		t.Fatal("resume did not apply")
	}
}

func TestPausedScreenObserverTakesNoScreenshot(t *testing.T) {
	var shots, windows atomic.Int32
	prevCap, prevWin := observerCaptureScreen, observerActiveWindow
	t.Cleanup(func() { observerCaptureScreen, observerActiveWindow = prevCap, prevWin })
	observerCaptureScreen = func() ([]byte, error) { shots.Add(1); return nil, errors.New("test: no screen") }
	observerActiveWindow = func() (string, string) { windows.Add(1); return "App", "Secret title" }
	send := func(context.Context, SidecarEvent, []byte) error {
		t.Error("a paused observer sent an event")
		return nil
	}

	pauseObservers(t, true, false)
	so := &ScreenObserver{intervalMs: 1000}
	so.capture(context.Background(), send)
	wo := &WindowObserver{intervalMs: 1000, stuckThresholdMs: 1 << 30, sameWindowSince: time.Now()}
	wo.poll(context.Background(), send)
	if shots.Load() != 0 || windows.Load() != 0 {
		t.Fatalf("paused: %d screenshot(s), %d active-window read(s); want none", shots.Load(), windows.Load())
	}

	// Resumed, the same calls reach the platform again (the test is not
	// passing because these paths never capture at all).
	screenObserversPaused.Store(false)
	so.capture(context.Background(), func(context.Context, SidecarEvent, []byte) error { return nil })
	wo.poll(context.Background(), func(context.Context, SidecarEvent, []byte) error { return nil })
	if shots.Load() != 1 || windows.Load() != 1 {
		t.Fatalf("resumed: %d screenshot(s), %d active-window read(s); want 1 and 1", shots.Load(), windows.Load())
	}
}

// The clipboard is not read while paused, and what was copied during the
// pause is not sent when it resumes: only a later change is.
func TestPausedClipboardObserverReadsNothingAndSendsNothingCopiedMeanwhile(t *testing.T) {
	var mu sync.Mutex
	clip, reads := "before", 0
	prev := readClipboardContent
	t.Cleanup(func() { readClipboardContent = prev })
	readClipboardContent = func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		reads++
		return clip, nil
	}
	set := func(s string) { mu.Lock(); clip = s; mu.Unlock() }
	readCount := func() int { mu.Lock(); defer mu.Unlock(); return reads }

	events := make(chan string, 16)
	send := func(_ context.Context, e SidecarEvent, _ []byte) error {
		events <- e.Payload["content"].(string)
		return nil
	}

	pauseObservers(t, false, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := &ClipboardObserver{pollInterval: 5 * time.Millisecond}
	done := make(chan struct{})
	go func() { o.Run(ctx, send); close(done) }()
	defer func() { cancel(); <-done }()

	set("copied while paused")
	time.Sleep(60 * time.Millisecond) // about a dozen ticks
	if n := readCount(); n != 0 {
		t.Fatalf("paused observer read the clipboard %d time(s)", n)
	}

	clipboardObserverPaused.Store(false)
	waitFor := func(cond func() bool) {
		deadline := time.Now().Add(2 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatal("timed out")
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
	waitFor(func() bool { return readCount() >= 2 })
	set("copied after resume")
	select {
	case got := <-events:
		if got != "copied after resume" {
			t.Fatalf("sent %q, want only what was copied after the resume", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a change after the resume was not sent")
	}
	select {
	case got := <-events:
		t.Fatalf("unexpected extra event %q", got)
	default:
	}
}

// #1159 review: the pause RPC must survive a config reload like the other
// connection handlers (TestConnectionHandlersSurviveAConfigReload).
func TestObserversSetPausedSurvivesAConfigReload(t *testing.T) {
	c := &SidecarClient{config: &SidecarConfig{}, claims: &SidecarTokenClaims{}, handlers: map[string]RPCHandler{}}
	c.setConnHandler("observers.set_paused", makeObserversSetPausedHandler())
	c.mu.Lock()
	c.rebuildHandlers() // what reloadConfig does
	c.mu.Unlock()
	if _, ok := c.handlers["observers.set_paused"]; !ok {
		t.Fatal("observers.set_paused is gone after a config reload: a pause would stay stuck until the next reconnect")
	}
}

// The usual path: an observer already running is paused mid-run. What is
// copied during the pause is not sent on resume.
func TestClipboardObserverPausedMidRunDoesNotSendWhatWasCopiedMeanwhile(t *testing.T) {
	var mu sync.Mutex
	clip, reads := "before", 0
	prev := readClipboardContent
	t.Cleanup(func() { readClipboardContent = prev })
	readClipboardContent = func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		reads++
		return clip, nil
	}
	set := func(s string) {
		mu.Lock()
		clip = s
		mu.Unlock()
	}
	readCount := func() int {
		mu.Lock()
		defer mu.Unlock()
		return reads
	}
	waitFor := func(cond func() bool) {
		deadline := time.Now().Add(2 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatal("timed out")
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
	events := make(chan string, 16)
	send := func(_ context.Context, e SidecarEvent, _ []byte) error {
		events <- e.Payload["content"].(string)
		return nil
	}

	pauseObservers(t, false, false)
	ctx, cancel := context.WithCancel(context.Background())
	o := &ClipboardObserver{pollInterval: 5 * time.Millisecond}
	done := make(chan struct{})
	go func() { o.Run(ctx, send); close(done) }()
	defer func() { cancel(); <-done }()

	waitFor(func() bool { return readCount() >= 3 }) // running, baseline taken
	clipboardObserverPaused.Store(true)
	time.Sleep(30 * time.Millisecond) // let a paused tick pass
	n := readCount()
	set("copied while paused")
	time.Sleep(30 * time.Millisecond)
	if got := readCount(); got > n+1 {
		t.Fatalf("paused observer kept reading the clipboard (%d reads after the pause)", got-n)
	}
	clipboardObserverPaused.Store(false)
	waitFor(func() bool { return readCount() >= n+3 })
	set("copied after resume")
	select {
	case got := <-events:
		if got != "copied after resume" {
			t.Fatalf("sent %q, want only what was copied after the resume", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a change after the resume was not sent")
	}
}

// A pause and resume that both land between two polls still re-baselines.
func TestClipboardPauseShorterThanAPollDoesNotLeak(t *testing.T) {
	var mu sync.Mutex
	clip, reads := "before", 0
	prev := readClipboardContent
	t.Cleanup(func() { readClipboardContent = prev })
	readClipboardContent = func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		reads++
		return clip, nil
	}
	set := func(s string) {
		mu.Lock()
		clip = s
		mu.Unlock()
	}
	readCount := func() int {
		mu.Lock()
		defer mu.Unlock()
		return reads
	}
	events := make(chan string, 16)
	send := func(_ context.Context, e SidecarEvent, _ []byte) error {
		events <- e.Payload["content"].(string)
		return nil
	}
	pauseObservers(t, false, false)
	h := makeObserversSetPausedHandler()
	ctx, cancel := context.WithCancel(context.Background())
	o := &ClipboardObserver{pollInterval: 250 * time.Millisecond}
	done := make(chan struct{})
	go func() { o.Run(ctx, send); close(done) }()
	defer func() { cancel(); <-done }()

	// Right after a poll, so the whole pause fits well inside the next gap.
	deadline := time.Now().Add(3 * time.Second)
	for readCount() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("observer never polled")
		}
		time.Sleep(time.Millisecond)
	}
	n := readCount()
	_, _ = h(map[string]any{"clipboard": true})
	set("copied while paused")
	_, _ = h(map[string]any{"clipboard": false})
	if readCount() != n {
		t.Skip("a poll landed inside the pause window; the scenario did not happen")
	}
	// Two more polls: the first re-baselines, nothing may be sent.
	deadline = time.Now().Add(3 * time.Second)
	for readCount() < n+2 {
		if time.Now().After(deadline) {
			t.Fatal("observer stopped polling")
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case got := <-events:
		t.Fatalf("sent %q copied during a pause", got)
	default:
	}
}
