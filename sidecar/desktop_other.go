//go:build !windows && !linux && !darwin

package main

import "fmt"

func handleListWindows(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}

func handleGetWindowTree(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}

func handleClickElement(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}

func handleTypeText(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}

func handlePressKeys(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}

func handleLaunchApp(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}

func handleFocusWindow(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}

func handleFindElement(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are not supported on this platform")
}
