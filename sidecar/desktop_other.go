//go:build !windows

package main

import "fmt"

func handleListWindows(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are only available on Windows")
}

func handleGetWindowTree(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are only available on Windows")
}

func handleClickElement(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are only available on Windows")
}

func handleTypeText(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are only available on Windows")
}

func handlePressKeys(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are only available on Windows")
}

func handleLaunchApp(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are only available on Windows")
}

func handleFocusWindow(params map[string]any) (*RPCResult, error) {
	return nil, fmt.Errorf("desktop tools are only available on Windows")
}
