package main

import (
	"encoding/json"
	"fmt"
)

// sub_pebble.spawn — show a colored sub-pebble overlay on the right rail.
// Params: full SubPebbleSpec ({id, color, slot, label, state}).
func makeSubPebbleSpawnHandler(svc SubPebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		spec, err := decodeSubPebbleSpec(params)
		if err != nil {
			return nil, err
		}
		if spec.ID == "" {
			return nil, fmt.Errorf("missing required parameter: id")
		}
		if err := svc.Spawn(spec); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"spawned": true, "id": spec.ID}}, nil
	}
}

// sub_pebble.set_state — change a sub-pebble's state (e.g. working → completed).
// Params: { "id": string, "state": "idle"|"listening"|... }
func makeSubPebbleSetStateHandler(svc SubPebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, _ := params["id"].(string)
		if id == "" {
			return nil, fmt.Errorf("missing required parameter: id")
		}
		stateStr, _ := params["state"].(string)
		if stateStr == "" {
			return nil, fmt.Errorf("missing required parameter: state")
		}
		if err := svc.SetState(id, PebbleState(stateStr)); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"id": id, "state": stateStr}}, nil
	}
}

// sub_pebble.set_color — recolor a sub-pebble (used to swap to vermilion
// on failure). Params: { "id": string, "color": string }
func makeSubPebbleSetColorHandler(svc SubPebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, _ := params["id"].(string)
		if id == "" {
			return nil, fmt.Errorf("missing required parameter: id")
		}
		color, _ := params["color"].(string)
		if color == "" {
			return nil, fmt.Errorf("missing required parameter: color")
		}
		if err := svc.SetColor(id, SubPebbleColor(color)); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"id": id, "color": color}}, nil
	}
}

// sub_pebble.set_expanded — toggle the click-to-inspect bubble.
// Params: { id, expanded, agent?, task?, result?, elapsed_s? }
func makeSubPebbleSetExpandedHandler(svc SubPebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, _ := params["id"].(string)
		if id == "" {
			return nil, fmt.Errorf("missing required parameter: id")
		}
		expanded, _ := params["expanded"].(bool)
		agent, _ := params["agent"].(string)
		task, _ := params["task"].(string)
		result, _ := params["result"].(string)
		elapsedS := 0
		if v, ok := params["elapsed_s"].(float64); ok {
			elapsedS = int(v)
		}
		if err := svc.SetExpanded(id, expanded, agent, task, result, elapsedS); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"id": id, "expanded": expanded}}, nil
	}
}

// sub_pebble.set_label — update a sub-pebble's label (used by the Phase B
// bubble; for now just stashed). Params: { "id": string, "label": string }
func makeSubPebbleSetLabelHandler(svc SubPebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, _ := params["id"].(string)
		if id == "" {
			return nil, fmt.Errorf("missing required parameter: id")
		}
		label, _ := params["label"].(string)
		if err := svc.SetLabel(id, label); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"id": id, "label": label}}, nil
	}
}

// sub_pebble.close — destroy a single sub-pebble overlay.
// Params: { "id": string }
func makeSubPebbleCloseHandler(svc SubPebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		id, _ := params["id"].(string)
		if id == "" {
			return nil, fmt.Errorf("missing required parameter: id")
		}
		if err := svc.Close(id); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"closed": true, "id": id}}, nil
	}
}

// sub_pebble.close_all — destroy every active sub-pebble overlay. Used
// on shutdown / explicit "close all background agents" voice intent.
func makeSubPebbleCloseAllHandler(svc SubPebbleService) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		if err := svc.CloseAll(); err != nil {
			return nil, err
		}
		return &RPCResult{Result: map[string]any{"closed_all": true}}, nil
	}
}

func decodeSubPebbleSpec(params map[string]any) (SubPebbleSpec, error) {
	var spec SubPebbleSpec
	if params == nil {
		return spec, nil
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return spec, fmt.Errorf("encode params: %w", err)
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		return spec, fmt.Errorf("decode sub-pebble spec: %w", err)
	}
	return spec, nil
}
