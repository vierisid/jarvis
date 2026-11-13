package main

import (
	"log"
	"sync/atomic"
)

// The brain's off switches, applied at the source (#1159). With awareness or
// desktop control turned off, the sidecar kept taking a screenshot, diffing
// it, saving it to disk and running OCR on it every tick, and reading the
// clipboard. The brain drops the screen events while desktop is off or the
// awareness service runs (src/daemon/sidecar-event-routing.ts), but with
// awareness off since startup they reached the generic event pipeline, and
// clipboard_change was never dropped. observers.set_paused stops them here.
//
// Not persisted: the brain pushes the current state on every connect and on
// every change, and a fresh process starts unpaused so that a brain that
// predates this RPC (and never sends it) keeps the observers it always had.
// Within one process the last state does carry over a reconnect: if the
// connect push is lost, or the sidecar reconnects to an older brain, the
// observers stay as last told (paused errs on the private side) until the
// next push or a restart.
//
//   - screen: the screen observer (screenshots, OCR) and the active-window
//     observer (app names, window titles). Paused while awareness or desktop
//     control is off.
//   - clipboard: the clipboard observer. Paused while desktop control is off.
//     Not tied to awareness: clipboard_change also feeds the
//     observer.clipboard_changed workflow trigger.
var (
	screenObserversPaused   atomic.Bool
	clipboardObserverPaused atomic.Bool
	// clipboardPauseEpoch counts clipboard pauses, so an observer whose poll
	// never saw the flag set (pause and resume inside one poll interval) still
	// knows to re-baseline instead of sending what was copied meanwhile.
	clipboardPauseEpoch atomic.Uint64
)

// screenObservationHeld reports whether the screen observer must skip work
// now: a voice turn is under way (ambient suppression), the brain paused it,
// or the notch is looking away (an app the person said never to watch, a
// password being typed, a bank: notch_where.go). Asked before the screenshot
// is taken, so what must not be seen is not captured at all.
func screenObservationHeld() bool {
	return screenObserversPaused.Load() || ambientSuppressedNow() || notchWhere.Look() != notchLooking
}

// makeObserversSetPausedHandler handles observers.set_paused. Params:
// { "screen": bool, "clipboard": bool }; a key that is absent (or not a bool)
// leaves that observer as it is.
func makeObserversSetPausedHandler() RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		if v, ok := params["screen"].(bool); ok {
			if screenObserversPaused.Swap(v) != v {
				log.Printf("[observers] screen and window observers %s by the brain", pausedWord(v))
			}
		}
		if v, ok := params["clipboard"].(bool); ok {
			if v {
				// Before the flag, so an observer that sees the flag set
				// or cleared also sees this pause's epoch.
				clipboardPauseEpoch.Add(1)
			}
			if clipboardObserverPaused.Swap(v) != v {
				log.Printf("[observers] clipboard observer %s by the brain", pausedWord(v))
			}
		}
		return &RPCResult{Result: map[string]any{
			"screen":    screenObserversPaused.Load(),
			"clipboard": clipboardObserverPaused.Load(),
		}}, nil
	}
}

func pausedWord(paused bool) string {
	if paused {
		return "paused"
	}
	return "resumed"
}
