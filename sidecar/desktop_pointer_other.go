//go:build !windows

package main

import "fmt"

// Acting at a place on the screen exists on Windows only for now. The refusal
// is made before anything is done.
func handlePointerAction(params map[string]any) (*RPCResult, error) {
	return nil, &codedError{code: desktopPointerRefusedCode, err: fmt.Errorf(
		"pointer_action is not available on this system yet (Windows only), so nothing was done. Use an element from desktop_snapshot instead")}
}

// Nothing can be said here about where an action would land.
func handleDescribeTarget(params map[string]any) (*RPCResult, error) {
	return &RPCResult{Result: map[string]any{}}, nil
}
