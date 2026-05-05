package main

import (
	"encoding/json"
	"fmt"
)

// panel.spawn — open a new native panel window. Returns the panel id.
//
// Params: full PanelSpec (url required, everything else optional).
// Result: { "id": "<panel-id>" }
func makePanelSpawnHandler(svc PanelService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		spec, err := decodePanelSpec(params)
		if err != nil {
			return nil, err
		}
		id, err := svc.Spawn(spec)
		if err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"id": string(id)}}, nil
	}
}

// panel.close — close a panel window by id.
// Params: { "id": "<panel-id>" }
func makePanelCloseHandler(svc PanelService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, err := requirePanelID(params)
		if err != nil {
			return nil, err
		}
		if err := svc.Close(id); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"closed": string(id)}}, nil
	}
}

// panel.focus — bring a panel to foreground.
// Params: { "id": "<panel-id>" }
func makePanelFocusHandler(svc PanelService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, err := requirePanelID(params)
		if err != nil {
			return nil, err
		}
		if err := svc.Focus(id); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"focused": string(id)}}, nil
	}
}

// panel.set_follow — turn the cursor-tracking goroutine on/off for a panel
// that was spawned with FollowCursor=true. Page calls this when the bubble
// opens (pause tracking so window stops jittering) and again on dismiss.
// Params: { "id": "<panel-id>", "follow": true|false }
func makePanelSetFollowHandler(svc PanelService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, err := requirePanelID(params)
		if err != nil {
			return nil, err
		}
		raw, ok := params["follow"]
		if !ok {
			return nil, fmt.Errorf("missing required parameter: follow")
		}
		follow, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("follow must be a boolean")
		}
		if err := svc.SetFollow(id, follow); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"id": string(id), "follow": follow}}, nil
	}
}

// panel.list — return all currently-open panel ids.
// Result: { "ids": ["a", "b", ...] }
func makePanelListHandler(svc PanelService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		ids := svc.List()
		out := make([]string, len(ids))
		for i, id := range ids {
			out[i] = string(id)
		}
		return &RPCResult{Result: map[string]any{"ids": out}}, nil
	}
}

// panel.set_window_state — switch a panel between normal / minimized /
// maximized. Used by T18b voice commands ("expand", "minimize",
// "restore"). Idempotent.
// Params: { "id": "<panel-id>", "state": "normal"|"minimized"|"maximized" }
func makePanelSetWindowStateHandler(svc PanelService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, err := requirePanelID(params)
		if err != nil {
			return nil, err
		}
		raw, ok := params["state"]
		if !ok {
			return nil, fmt.Errorf("missing required parameter: state")
		}
		s, ok := raw.(string)
		if !ok || s == "" {
			return nil, fmt.Errorf("state must be a non-empty string")
		}
		state := PanelWindowState(s)
		switch state {
		case PanelWindowNormal, PanelWindowMinimized, PanelWindowMaximized:
		default:
			return nil, fmt.Errorf("state must be one of: normal, minimized, maximized")
		}
		if err := svc.SetWindowState(id, state); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"id": string(id), "state": s}}, nil
	}
}

// decodePanelSpec converts the loose JSON params map into a typed PanelSpec
// via a JSON round-trip. This avoids hand-coding type assertions for ~10 fields.
func decodePanelSpec(params map[string]any) (PanelSpec, error) {
	var spec PanelSpec
	if params == nil {
		return spec, fmt.Errorf("missing params")
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return spec, fmt.Errorf("encode params: %w", err)
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		return spec, fmt.Errorf("decode panel spec: %w", err)
	}
	if spec.URL == "" {
		return spec, fmt.Errorf("missing required parameter: url")
	}
	return spec, nil
}

func requirePanelID(params map[string]any) (PanelID, error) {
	if params == nil {
		return "", fmt.Errorf("missing params")
	}
	raw, ok := params["id"]
	if !ok {
		return "", fmt.Errorf("missing required parameter: id")
	}
	id, ok := raw.(string)
	if !ok || id == "" {
		return "", fmt.Errorf("id must be a non-empty string")
	}
	return PanelID(id), nil
}
