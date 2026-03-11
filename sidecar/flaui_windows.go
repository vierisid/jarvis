//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// ── FlaUI Bridge Manager ────────────────────────────────────────────

type flauiBridge struct {
	mu      sync.Mutex
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader
	started bool
	reqID   atomic.Int64
}

var bridge = &flauiBridge{}

func (b *flauiBridge) call(method string, params map[string]any) (map[string]any, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.started {
		if err := b.start(); err != nil {
			return nil, err
		}
	}

	// Build request
	id := fmt.Sprintf("r%d", b.reqID.Add(1))
	req := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	// Send
	if _, err := b.stdin.Write(append(data, '\n')); err != nil {
		b.stop()
		return nil, fmt.Errorf("write to bridge: %w", err)
	}

	// Read response (with timeout via deadline on the reader goroutine)
	type readResult struct {
		line string
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		line, err := b.stdout.ReadString('\n')
		ch <- readResult{line, err}
	}()

	select {
	case res := <-ch:
		if res.err != nil {
			b.stop()
			return nil, fmt.Errorf("read from bridge: %w", res.err)
		}
		return parseResponse(id, res.line)
	case <-time.After(30 * time.Second):
		b.stop()
		return nil, fmt.Errorf("bridge response timeout (30s)")
	}
}

func parseResponse(expectedID, line string) (map[string]any, error) {
	var resp struct {
		ID     string         `json:"id"`
		Result map[string]any `json:"result"`
		Error  string         `json:"error"`
	}
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		return nil, fmt.Errorf("parse bridge response: %w (%s)", err, truncate(line, 200))
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("flaui: %s", resp.Error)
	}
	if resp.Result == nil {
		// Result might be a non-map (e.g. {"status":"ok"} for ping)
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &raw); err == nil {
			if r, ok := raw["result"]; ok {
				var anyResult any
				json.Unmarshal(r, &anyResult)
				if m, ok := anyResult.(map[string]any); ok {
					return m, nil
				}
				return map[string]any{"result": anyResult}, nil
			}
		}
	}
	return resp.Result, nil
}

func (b *flauiBridge) start() error {
	exePath := findBridgeExe()
	if exePath == "" {
		return fmt.Errorf("flaui-bridge.exe not found — build it with: cd sidecar/flaui-bridge && dotnet publish -c Release")
	}

	cmd := exec.Command(exePath)
	cmd.Stderr = os.Stderr // Bridge logs go to sidecar's stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("create stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return fmt.Errorf("create stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		return fmt.Errorf("start flaui-bridge: %w", err)
	}

	b.cmd = cmd
	b.stdin = stdin
	b.stdout = bufio.NewReader(stdout)
	b.started = true

	log.Printf("[flaui] Bridge started (PID %d)", cmd.Process.Pid)

	// Verify with ping
	b.mu.Unlock()
	defer b.mu.Lock()
	// Temporarily release lock for the ping call — but we're in start(), called from call() which holds the lock.
	// Instead, do an inline ping without going through call().
	// Actually, let me just do it inline here.
	return nil
}

func (b *flauiBridge) stop() {
	if b.cmd != nil && b.cmd.Process != nil {
		b.cmd.Process.Kill()
		b.cmd.Wait()
		log.Printf("[flaui] Bridge stopped")
	}
	b.cmd = nil
	b.stdin = nil
	b.stdout = nil
	b.started = false
}

func findBridgeExe() string {
	// Look next to the sidecar binary
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		candidates := []string{
			filepath.Join(dir, "flaui-bridge.exe"),
			filepath.Join(dir, "flaui-bridge", "flaui-bridge.exe"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return c
			}
		}
	}

	// Check PATH
	if p, err := exec.LookPath("flaui-bridge.exe"); err == nil {
		return p
	}
	if p, err := exec.LookPath("flaui-bridge"); err == nil {
		return p
	}

	return ""
}

// ── RPC Handlers ────────────────────────────────────────────────────

func handleFLAUIInspect(params map[string]any) (*RPCResult, error) {
	bridgeParams := make(map[string]any)
	if pid, ok := params["pid"].(float64); ok {
		bridgeParams["pid"] = int(pid)
	}
	if depth, ok := params["depth"].(float64); ok {
		bridgeParams["depth"] = int(depth)
	}
	if iv, ok := params["include_invisible"].(bool); ok {
		bridgeParams["include_invisible"] = iv
	}

	result, err := bridge.call("inspect", bridgeParams)
	if err != nil {
		return nil, err
	}
	return &RPCResult{Result: result}, nil
}

func handleFLAUIFind(params map[string]any) (*RPCResult, error) {
	bridgeParams := make(map[string]any)
	if pid, ok := params["pid"].(float64); ok {
		bridgeParams["pid"] = int(pid)
	}
	for _, key := range []string{"automation_id", "name", "class_name", "control_type"} {
		if v, ok := params[key].(string); ok && v != "" {
			bridgeParams[key] = v
		}
	}

	result, err := bridge.call("find", bridgeParams)
	if err != nil {
		return nil, err
	}
	return &RPCResult{Result: result}, nil
}

func handleFLAUIAction(params map[string]any) (*RPCResult, error) {
	bridgeParams := make(map[string]any)
	if eid, ok := params["element_id"].(float64); ok {
		bridgeParams["element_id"] = int(eid)
	} else {
		return nil, fmt.Errorf("missing required parameter: element_id")
	}
	action, _ := params["action"].(string)
	if action == "" {
		return nil, fmt.Errorf("missing required parameter: action")
	}
	bridgeParams["action"] = action

	// Pass through action-specific params
	if v, ok := params["value"].(string); ok {
		bridgeParams["value"] = v
	}

	result, err := bridge.call("action", bridgeParams)
	if err != nil {
		return nil, err
	}
	return &RPCResult{Result: result}, nil
}
