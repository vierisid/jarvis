package main

import (
	"sync"
	"sync/atomic"
)

// TrayStatus is the live data the tray menu shows (design: usejarvis-tray.html
// §00). The brain pushes it via the `tray.status` RPC; the tray thread reads
// it when the menu opens. Platform-neutral so Windows + macOS share one source
// of truth.
type TrayStatus struct {
	State       string   // pebble state: idle/listening/thinking/speaking/asking/done/muted
	Waiting     int      // pending approvals — the "Waiting on you" row
	Recent      []string // recent activity lines ("Sent the Acme reply · 2m"), newest first
	Paused      bool     // agent paused
	Muted       bool     // microphone muted
	BrainOnline bool
	Sidecars    string // "2/2"
	Port        int
}

var (
	trayStatusMu  sync.RWMutex
	trayStatusCur = TrayStatus{State: "idle", Port: 3142}
	// trayRefresh nudges the platform tray to update (icon/tooltip) when the
	// status changes out of band. Set by the platform tray; no-op elsewhere.
	trayRefresh = func() {}
	// trayApplyMuteV gates the microphone locally when the tray "Mute microphone"
	// toggle flips. Mic control the sidecar owns (not the brain): it pauses the
	// wake listener, ends any live realtime session, and reflects it on the
	// pebble. Set by the client once its audio services exist; no-op until then.
	// atomic.Value because connectAndServe re-assigns it on every reconnect while
	// the tray (Windows) / Cocoa (macOS) threads read it — a plain var is a data
	// race. Use trayApplyMute()/setTrayApplyMute(), never the var directly.
	trayApplyMuteV atomic.Value // func(bool)
)

func trayApplyMute(muted bool) {
	if f, ok := trayApplyMuteV.Load().(func(bool)); ok && f != nil {
		f(muted)
	}
}

func setTrayApplyMute(f func(bool)) { trayApplyMuteV.Store(f) }

// trayCtlQ serializes mute/pause side effects off the UI threads. The work
// (audio-device teardown, WS emits) must not block the tray/Cocoa thread, but
// one goroutine per toggle had no ordering guarantee — a rapid double-toggle
// could interleave and leave the mic state diverging from the menu. A single
// worker drains in click order.
var trayCtlQ = make(chan func(), 32)

func init() {
	go func() {
		for f := range trayCtlQ {
			f()
		}
	}()
}

// trayCtlAsync enqueues f for the serialized worker. The 32-deep buffer is far
// beyond any human toggle rate; if it ever fills (wedged brain connection),
// fall back to a raw goroutine rather than blocking the UI thread.
func trayCtlAsync(f func()) {
	select {
	case trayCtlQ <- f:
	default:
		go f()
	}
}

func setTrayStatus(s TrayStatus) {
	trayStatusMu.Lock()
	trayStatusCur = s
	trayStatusMu.Unlock()
	trayRefresh()
}

func getTrayStatus() TrayStatus {
	trayStatusMu.RLock()
	defer trayStatusMu.RUnlock()
	s := trayStatusCur
	s.Recent = append([]string(nil), trayStatusCur.Recent...) // copy to avoid a data race
	return s
}

// trayStateCode maps a pebble state string (as pushed in tray.status) to the
// pebble state int the tray icon dot is drawn from — same numbering as
// pebbleStateToInt. Platform-neutral so Windows + macOS share the mapping.
func trayStateCode(s string) int {
	switch s {
	case "listening":
		return 1
	case "thinking":
		return 2
	case "speaking":
		return 3
	case "working":
		return 4
	case "asking":
		return 5
	case "done":
		return 6
	case "muted":
		return 7
	default:
		return 0
	}
}

// trayStatusFromParams merges a `tray.status` RPC payload over the current
// status (partial updates are fine — the brain may send only what changed).
func trayStatusFromParams(params map[string]any) TrayStatus {
	s := getTrayStatus()
	if v, ok := params["state"].(string); ok && v != "" {
		s.State = v
	}
	if v, ok := params["waiting"].(float64); ok {
		s.Waiting = int(v)
	}
	if v, ok := params["paused"].(bool); ok {
		s.Paused = v
	}
	if v, ok := params["muted"].(bool); ok {
		s.Muted = v
	}
	if v, ok := params["brain_online"].(bool); ok {
		s.BrainOnline = v
	}
	if v, ok := params["sidecars"].(string); ok {
		s.Sidecars = v
	}
	if v, ok := params["port"].(float64); ok && v > 0 {
		s.Port = int(v)
	}
	if arr, ok := params["recent"].([]any); ok {
		s.Recent = s.Recent[:0]
		for _, it := range arr {
			if str, ok := it.(string); ok {
				s.Recent = append(s.Recent, str)
			}
		}
	}
	return s
}
