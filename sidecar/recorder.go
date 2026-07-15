package main

// recorder.go — cross-platform skill-recorder plumbing.
//
// The platform-specific input hook + focused-element capture lives in
// recorder_windows.go (real) and recorder_other.go (stub). This file holds the
// shared event sender and the recorder_start / recorder_stop RPC handlers, so
// the handler registry does not need to know the platform.

import (
	"context"
	"sync"
)

var (
	recorderMu     sync.Mutex
	recorderCtx    context.Context
	recorderSend   EventSender
	recorderActive bool
)

// setRecorderSender wires the observer event channel to the recorder. Called
// once observers start (client.go).
func setRecorderSender(ctx context.Context, send EventSender) {
	recorderMu.Lock()
	recorderCtx = ctx
	recorderSend = send
	recorderMu.Unlock()
}

// emitInteraction sends one ui_interaction event to the brain. The payload
// shape matches src/skills/recorder.ts RawInteraction. Secret redaction is
// done brain-side at push time; the sidecar marks secure fields via `secure`.
func emitInteraction(payload map[string]any) {
	recorderMu.Lock()
	ctx, send := recorderCtx, recorderSend
	recorderMu.Unlock()
	if send == nil || ctx == nil {
		return
	}
	_ = send(ctx, SidecarEvent{EventType: "ui_interaction", Payload: payload}, nil)
}

// handleRecorderStart / handleRecorderStop toggle the platform input hook.
// startInputRecording / stopInputRecording are implemented per-platform.
func handleRecorderStart(params map[string]any) (*RPCResult, error) {
	recorderMu.Lock()
	if recorderActive {
		recorderMu.Unlock()
		return &RPCResult{Result: map[string]any{"recording": true, "note": "already recording"}}, nil
	}
	recorderActive = true
	recorderMu.Unlock()

	if err := startInputRecording(); err != nil {
		recorderMu.Lock()
		recorderActive = false
		recorderMu.Unlock()
		return nil, err
	}
	return &RPCResult{Result: map[string]any{"recording": true}}, nil
}

func handleRecorderStop(params map[string]any) (*RPCResult, error) {
	recorderMu.Lock()
	wasActive := recorderActive
	recorderActive = false
	recorderMu.Unlock()
	if wasActive {
		stopInputRecording()
	}
	return &RPCResult{Result: map[string]any{"recording": false}}, nil
}
