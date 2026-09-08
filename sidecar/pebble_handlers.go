package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
)

// pebble.spawn — show the native pebble overlay on the desktop.
// Params: full PebbleSpec (cursor offset + summon hotkey, all optional).
func makePebbleSpawnHandler(svc PebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		spec, err := decodePebbleSpec(params)
		if err != nil {
			return nil, err
		}
		if err := svc.Spawn(spec); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"spawned": true}}, nil
	}
}

// pebble.close — hide + destroy the overlay.
func makePebbleCloseHandler(svc PebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		if err := svc.Close(); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"closed": true}}, nil
	}
}

// pebble.set_state — transition the overlay to a new visual state and
// optionally update the bubble body text.
//
//	Params: {
//	  "state": "idle"|"listening"|"thinking"|"speaking"|"working",
//	  "text":  optional string — bubble body line; omit/empty for default copy
//	}
func makePebbleSetStateHandler(svc PebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		raw, ok := params["state"]
		if !ok {
			return nil, fmt.Errorf("missing required parameter: state")
		}
		s, ok := raw.(string)
		if !ok || s == "" {
			return nil, fmt.Errorf("state must be a non-empty string")
		}
		// Apply text BEFORE state so the next paint already has the new
		// body line — avoids one frame of stale "speaking…" placeholder.
		if rawText, hasText := params["text"]; hasText {
			text, _ := rawText.(string)
			// The brain owns the bubble from here: cancel any pending muted
			// nudge so its expiry doesn't blank this text a second later.
			invalidateMutedNudge()
			if err := svc.SetText(text); err != nil {
				return nil, err
			}
		}
		if err := svc.SetState(PebbleState(s)); err != nil {
			return nil, err
		}
		// The daemon drives this for the whole turn, on every path into the
		// voice loop, including the single-shot wake ("Jarvis, do X"), which
		// never runs a local session capture and so has no other early hook.
		// Hold ambient screen awareness off from the first non-idle state
		// rather than waiting for the first TTS clip to land, so a capture tick
		// can't already be mid-OCR when playback opens its device.
		// Deliberately not PebbleWorking: a backgrounded agent task can sit in
		// that state for minutes and has no audio to protect.
		switch PebbleState(s) {
		case PebbleListening, PebbleThinking, PebbleSpeaking:
			ambientHoldFor(voiceTurnAmbientHold)
		case PebbleIdle:
			// Unscoped: the daemon is the authority on the turn being over, and
			// this handler has no hold of its own to pair the end against.
			ambientEndHoldAfter(ambientHoldUnscoped, pebbleStateAmbientTail)
		}
		return &RPCResult{Result: map[string]any{"state": s}}, nil
	}
}

// pebble.play_audio — plays a TTS clip through the system's default output
// device. Used by the daemon's voice cycle once an LLM response has been
// synthesized; lets JARVIS speak even when the dashboard isn't running.
//
// Params: {
//   "data":      base64-encoded audio bytes (MP3 or WAV — sniffed at decode),
//   "mime_type": optional hint ("audio/mp3" / "audio/wav"); used as a
//                fallback when the magic-byte sniff is ambiguous,
//   "blocking":  optional bool, accepted for backwards compatibility. It
//                only changes the shape of the result: this RPC has never
//                waited for playback to finish, and returns as soon as the
//                clip is queued either way.
// }
//
// The clip is queued on the calling goroutine, NOT handed to a new one.
// Queueing is a channel send that cannot block (a full queue is an error), and
// the daemon dispatches one sentence per RPC and awaits each result before
// sending the next. Spawning a goroutine here broke that ordering: the two
// clips raced to the queue, so a long answer could speak its sentences out of
// sequence.
func makePebblePlayAudioHandler(svc *AudioPlaybackService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		rawData, ok := params["data"]
		if !ok {
			return nil, fmt.Errorf("missing required parameter: data")
		}
		dataStr, ok := rawData.(string)
		if !ok {
			return nil, fmt.Errorf("data must be a base64 string")
		}
		audio, err := base64.StdEncoding.DecodeString(dataStr)
		if err != nil {
			return nil, fmt.Errorf("decode base64: %w", err)
		}

		mime := ""
		if v, ok := params["mime_type"].(string); ok {
			mime = v
		}
		blocking := false
		if v, ok := params["blocking"].(bool); ok {
			blocking = v
		}

		if err := svc.Play(audio, mime); err != nil {
			if blocking {
				return nil, err
			}
			// The daemon's voice cycle fires these and moves on, so a failure
			// here is logged rather than returned.
			log.Printf("[playback] enqueue failed: %v", err)
		}

		if blocking {
			return &RPCResult{Result: map[string]any{
				"played": true,
				"bytes":  len(audio),
			}}, nil
		}

		return &RPCResult{Result: map[string]any{
			"queued": true,
			"bytes":  len(audio),
		}}, nil
	}
}

// pebble.set_eye (W6-T1) — flash the awareness eye glyph. Daemon
// turns it on when sidecar emits a screen_capture event and clears it
// after ~800 ms. Params: { "active": bool }
func makePebbleSetEyeHandler(svc PebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		active, _ := params["active"].(bool)
		if err := svc.SetEye(active); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"active": active}}, nil
	}
}

// pebble.set_answer_overflow — flag the speaking bubble as overflowing
// the visible cap so the sidecar paints an "open full ↗" button. Daemon
// also passes the answer id the user will fetch when they click.
// Empty answer_id clears the button.
// Params: { "answer_id": string }
func makePebbleSetAnswerOverflowHandler(svc PebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		answerID, _ := params["answer_id"].(string)
		if err := svc.SetAnswerOverflow(answerID); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"answer_id": answerID}}, nil
	}
}

// pebble.set_blinded (W6-T2) — mark awareness as hard-paused. The pebble
// shows a struck-through eye glyph. Daemon also persists awareness.enabled
// to the config so the state survives restart. Params: { "blinded": bool }
func makePebbleSetBlindedHandler(svc PebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		blinded, _ := params["blinded"].(bool)
		if err := svc.SetBlinded(blinded); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"blinded": blinded}}, nil
	}
}

// pebble.point_at — animate the pebble to (x, y) on screen with a
// label callout. Used by T8's `[POINT:x,y:label]` LLM tags.
// Params: { "x": int, "y": int, "label": string, "duration_ms": int (optional, default 3000) }
func makePebblePointAtHandler(svc PebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		xRaw, ok := params["x"]
		if !ok {
			return nil, fmt.Errorf("missing required parameter: x")
		}
		yRaw, ok := params["y"]
		if !ok {
			return nil, fmt.Errorf("missing required parameter: y")
		}
		xF, _ := xRaw.(float64)
		yF, _ := yRaw.(float64)
		label, _ := params["label"].(string)
		durMs := 3000
		if d, ok := params["duration_ms"].(float64); ok && d > 0 {
			durMs = int(d)
		}
		if err := svc.PointAt(int(xF), int(yF), label, durMs); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"pointed": true}}, nil
	}
}

// pebble.stop_audio — interrupt the currently playing TTS clip. Used
// when the user dismisses the pebble mid-speech (e.g. second hotkey
// press during the speaking state). No-op when nothing is playing.
func makePebbleStopAudioHandler(svc *AudioPlaybackService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		svc.Stop()
		return &RPCResult{Result: map[string]any{"stopped": true}}, nil
	}
}

// decodePebbleSpec converts a loose JSON params map into a typed PebbleSpec
// via a JSON round-trip. All fields optional — Spawn applies sensible
// defaults when zero.
func decodePebbleSpec(params map[string]any) (PebbleSpec, error) {
	var spec PebbleSpec
	if params == nil {
		return spec, nil
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return spec, fmt.Errorf("encode params: %w", err)
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		return spec, fmt.Errorf("decode pebble spec: %w", err)
	}
	return spec, nil
}
