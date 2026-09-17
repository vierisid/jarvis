package main

// recorder.go: cross-platform skill-recorder plumbing.
//
// The platform-specific input hook + acted-element capture lives in
// recorder_windows.go (real) and recorder_other.go (stub); each assigns the
// inputHookStart / inputHookStop variables in its init so this file, and its
// tests, never need to know the platform. This file holds the shared event
// sender, the recorder_start / recorder_stop RPC handlers, the session cap,
// and the visible indicator.
//
// Invariants:
//   - A recording is bounded. recorder_start arms a timer at the requested
//     max_ms (clamped to [recorderMinCap, recorderMaxCap]); when it fires the
//     hooks come out whether or not the brain ever sends recorder_stop. A
//     brain crash cannot leave WH_MOUSE_LL / WH_KEYBOARD_LL installed for the
//     process lifetime.
//   - A recording is visible. While the hooks are installed the pebble shows
//     the working state with a "Recording a skill" line, and a native
//     notification announces the start and the end.
//   - start and stop are serialized under recorderOpMu, so a stop that races
//     a start cannot leave hooks installed with recorderActive false.
//   - The brain hears about every end (ui_recording {state: stopped, reason})
//     so its own session closes with the hooks.

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

const (
	recorderDefaultCap = 10 * time.Minute
	recorderMaxCap     = 30 * time.Minute
)

// recorderMinCap is a var only so tests can fire the cap quickly; production
// never changes it.
var recorderMinCap = 10 * time.Second

func recorderMinCapOverride(d time.Duration) { recorderMinCap = d }

var (
	// recorderMu guards the sender fields, read by emitInteraction from the
	// capture goroutine while connectAndServe may be re-assigning them.
	recorderMu   sync.Mutex
	recorderCtx  context.Context
	recorderSend EventSender

	// recorderOpMu serializes start / stop / cap expiry as whole operations.
	recorderOpMu   sync.Mutex
	recorderActive bool
	recorderTimer  *time.Timer

	// Platform hook control, assigned by recorder_windows.go / recorder_other.go.
	inputHookStart func() error
	inputHookStop  func()

	// recorderPebble is the overlay used as the indicator; nil when the
	// pebble capability is off, in which case only the notification shows.
	recorderPebble PebbleService
)

// setRecorderSender wires the observer event channel to the recorder. Called
// once observers start (client.go).
func setRecorderSender(ctx context.Context, send EventSender) {
	recorderMu.Lock()
	recorderCtx = ctx
	recorderSend = send
	recorderMu.Unlock()
}

// setRecorderIndicator hands the recorder the pebble it should light while a
// recording is live. Safe with a nil service.
func setRecorderIndicator(p PebbleService) {
	recorderOpMu.Lock()
	recorderPebble = p
	recorderOpMu.Unlock()
}

func recorderEmit(eventType string, payload map[string]any) {
	recorderMu.Lock()
	ctx, send := recorderCtx, recorderSend
	recorderMu.Unlock()
	if send == nil || ctx == nil {
		return
	}
	_ = send(ctx, SidecarEvent{EventType: eventType, Payload: payload}, nil)
}

// emitInteraction sends one ui_interaction event to the brain. The payload
// shape matches src/skills/recorder.ts RawInteraction. Secret redaction is
// done brain-side at push time; the sidecar marks secure fields via `secure`
// and never includes their value.
func emitInteraction(payload map[string]any) {
	recorderEmit("ui_interaction", payload)
}

// recorderIndicator shows or clears the visible recording state. Runs under
// recorderOpMu; the pebble calls are cheap and the notification is async.
func recorderIndicator(on bool, capDur time.Duration) {
	if on {
		if recorderPebble != nil {
			_ = recorderPebble.SetText("Recording a skill")
			_ = recorderPebble.SetState(PebbleWorking)
		}
		go showNotification(Notification{
			ID:    "skill-recording",
			Kind:  "recording",
			Title: "Jarvis is recording a skill",
			Body:  fmt.Sprintf("Your clicks and typing in every app are being watched until you stop the recording or %d minutes pass.", int(capDur/time.Minute)),
		})
		return
	}
	if recorderPebble != nil {
		_ = recorderPebble.SetText("")
		_ = recorderPebble.SetState(PebbleIdle)
	}
	go showNotification(Notification{
		ID:    "skill-recording",
		Kind:  "recording",
		Title: "Recording stopped",
		Body:  "Jarvis is no longer watching your clicks and typing.",
	})
}

// recorderCapFromParams reads max_ms and clamps it to the allowed window.
func recorderCapFromParams(params map[string]any) time.Duration {
	capDur := recorderDefaultCap
	switch v := params["max_ms"].(type) {
	case float64:
		capDur = time.Duration(v) * time.Millisecond
	case int:
		capDur = time.Duration(v) * time.Millisecond
	case int64:
		capDur = time.Duration(v) * time.Millisecond
	}
	if capDur < recorderMinCap {
		capDur = recorderMinCap
	}
	if capDur > recorderMaxCap {
		capDur = recorderMaxCap
	}
	return capDur
}

// handleRecorderStart installs the platform input hook and arms the cap.
// A failed install is reported as an error, never as {"recording": true}.
func handleRecorderStart(params map[string]any) (*RPCResult, error) {
	recorderOpMu.Lock()
	defer recorderOpMu.Unlock()

	capDur := recorderCapFromParams(params)
	if recorderActive {
		return &RPCResult{Result: map[string]any{"recording": true, "note": "already recording", "max_ms": capDur.Milliseconds()}}, nil
	}
	if inputHookStart == nil {
		return nil, fmt.Errorf("skill recording is not available in this build")
	}
	if err := inputHookStart(); err != nil {
		return nil, fmt.Errorf("could not install the input hook: %w", err)
	}
	recorderActive = true
	recorderTimer = time.AfterFunc(capDur, func() { stopRecording("cap") })
	recorderIndicator(true, capDur)
	log.Printf("[recorder] recording started (cap %s)", capDur)
	return &RPCResult{Result: map[string]any{"recording": true, "max_ms": capDur.Milliseconds()}}, nil
}

func handleRecorderStop(params map[string]any) (*RPCResult, error) {
	stopRecording("rpc")
	return &RPCResult{Result: map[string]any{"recording": false}}, nil
}

// stopRecording removes the hooks if they are installed and tells the brain.
// reason is "rpc" (recorder_stop), "cap" (timer) or "shutdown".
func stopRecording(reason string) {
	recorderOpMu.Lock()
	defer recorderOpMu.Unlock()
	if !recorderActive {
		return
	}
	recorderActive = false
	if recorderTimer != nil {
		recorderTimer.Stop()
		recorderTimer = nil
	}
	if inputHookStop != nil {
		inputHookStop()
	}
	recorderIndicator(false, 0)
	log.Printf("[recorder] recording stopped (%s)", reason)
	recorderEmit("ui_recording", map[string]any{"state": "stopped", "reason": reason, "ts": time.Now().UnixMilli()})
}

// recorderIsActive reports whether hooks are installed (tests, shutdown).
func recorderIsActive() bool {
	recorderOpMu.Lock()
	defer recorderOpMu.Unlock()
	return recorderActive
}
