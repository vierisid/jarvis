//go:build !windows

package main

import "fmt"

func makeBrowserNavigateHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return nil, fmt.Errorf("browser tools are only available on Windows")
	}
}

func makeBrowserSnapshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return nil, fmt.Errorf("browser tools are only available on Windows")
	}
}

func makeBrowserClickHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return nil, fmt.Errorf("browser tools are only available on Windows")
	}
}

func makeBrowserTypeHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return nil, fmt.Errorf("browser tools are only available on Windows")
	}
}

func makeBrowserScreenshotHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return nil, fmt.Errorf("browser tools are only available on Windows")
	}
}

func makeBrowserScrollHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return nil, fmt.Errorf("browser tools are only available on Windows")
	}
}

func makeBrowserEvaluateHandler(cfg *SidecarConfig) RPCHandler {
	return func(params map[string]any) (*RPCResult, error) {
		return nil, fmt.Errorf("browser tools are only available on Windows")
	}
}

func launchChromeIfNeeded(cfg *SidecarConfig) {}
