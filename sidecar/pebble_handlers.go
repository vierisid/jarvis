package main

import (
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
