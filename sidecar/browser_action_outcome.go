package main

import "errors"

// Negotiated separately from snapshot binding: older handlers return refusals
// as successful text replies. Preserve that wire format for older brains.
const featureBrowserActionOutcomes = "browser_action_outcomes"

func browserActionRefusal(params map[string]any, message string, mayHaveOccurred bool) (*RPCResult, error) {
	if typed, _ := params["action_outcome"].(bool); !typed {
		return &RPCResult{Result: message}, nil
	}
	code := "BROWSER_ACTION_REFUSED"
	if mayHaveOccurred {
		code = "BROWSER_ACTION_UNCERTAIN"
	}
	return nil, &codedError{code: code, err: errors.New(message)}
}
