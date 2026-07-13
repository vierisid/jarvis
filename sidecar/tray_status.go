package main

import "sync"

// TrayStatus is the live data the tray menu shows (design: usejarvis-tray-
// FABLE5.html §00). The brain pushes it via the `tray.status` RPC; the tray
// thread reads it when the menu opens. Platform-neutral so Windows + macOS
// share one source of truth.
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
)

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
