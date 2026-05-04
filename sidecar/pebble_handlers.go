package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
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
			if err := svc.SetText(text); err != nil {
				return nil, err
			}
		}
		if err := svc.SetState(PebbleState(s)); err != nil {
			return nil, err
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
//   "blocking":  optional bool — if true, the RPC waits until playback
//                finishes; otherwise it returns immediately and playback
//                runs in the background.
// }
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

		if blocking {
			if err := svc.Play(audio, mime); err != nil {
				return nil, err
			}
			return &RPCResult{Result: map[string]any{
				"played": true,
				"bytes":  len(audio),
			}}, nil
		}

		// Fire-and-forget — daemon's voice cycle calls this and continues.
		// Sidecar logs (not RPC-returns) any decode/playback failure.
		go func(buf []byte, m string) {
			if err := svc.Play(buf, m); err != nil {
				fmt.Printf("[playback] error: %v\n", err)
			}
		}(audio, mime)

		return &RPCResult{Result: map[string]any{
			"queued": true,
			"bytes":  len(audio),
		}}, nil
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
