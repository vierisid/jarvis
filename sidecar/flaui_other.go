//go:build !windows

package main

import "fmt"

func handleFLAUIInspect(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("FlaUI is only available on Windows")
}

func handleFLAUIFind(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("FlaUI is only available on Windows")
}

func handleFLAUIAction(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("FlaUI is only available on Windows")
}
