package main

import (
	"context"
	"log"
	"sync"
	"time"
)

// processInfo is one row from the platform process list.
type processInfo struct {
	PID    int
	Name   string
	CPU    float64
	Memory float64
}

// ProcessObserver polls the system process list and emits process_started /
// process_stopped events on change. It mirrors the brain's old ProcessMonitor
// (payload {pid, name, cpu, memory} for starts, {pid, name} for stops) so the
// event classifier, vault, and `observer.process_*` workflow triggers keep
// working after the move from brain to sidecar.
type ProcessObserver struct {
	pollInterval time.Duration
	known        map[int]string // pid -> name
	mu           sync.Mutex
}

func NewProcessObserver(pollMs int) *ProcessObserver {
	if pollMs <= 0 {
		pollMs = 5000
	}
	return &ProcessObserver{
		pollInterval: time.Duration(pollMs) * time.Millisecond,
		known:        make(map[int]string),
	}
}

// Run seeds the baseline (without emitting), then polls until ctx is cancelled.
func (o *ProcessObserver) Run(ctx context.Context, send EventSender) {
	log.Printf("[processes] Monitoring processes (every %s)", o.pollInterval)

	// Seed without emitting so we don't flood with a process_started for every
	// process already running at startup.
	if procs, err := platformListProcesses(); err != nil {
		log.Printf("[processes] Failed to get initial process list: %v", err)
	} else {
		o.mu.Lock()
		for _, p := range procs {
			o.known[p.PID] = p.Name
		}
		o.mu.Unlock()
		log.Printf("[processes] Seeded with %d processes", len(procs))
	}

	ticker := time.NewTicker(o.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			o.poll(ctx, send)
		}
	}
}

func (o *ProcessObserver) poll(ctx context.Context, send EventSender) {
	procs, err := platformListProcesses()
	if err != nil {
		return
	}

	current := make(map[int]bool, len(procs))

	o.mu.Lock()
	// Started
	var started []processInfo
	for _, p := range procs {
		current[p.PID] = true
		if _, ok := o.known[p.PID]; !ok {
			o.known[p.PID] = p.Name
			started = append(started, p)
		}
	}
	// Stopped
	type stopped struct {
		pid  int
		name string
	}
	var gone []stopped
	for pid, name := range o.known {
		if !current[pid] {
			delete(o.known, pid)
			gone = append(gone, stopped{pid, name})
		}
	}
	o.mu.Unlock()

	for _, p := range started {
		event := SidecarEvent{
			Type:      "sidecar_event",
			EventType: "process_started",
			Timestamp: time.Now().UnixMilli(),
			Priority:  "low",
			Payload: map[string]any{
				"pid":    p.PID,
				"name":   p.Name,
				"cpu":    p.CPU,
				"memory": p.Memory,
			},
		}
		if err := send(ctx, event, nil); err != nil {
			log.Printf("[processes] Failed to send process_started: %v", err)
		}
	}
	for _, p := range gone {
		event := SidecarEvent{
			Type:      "sidecar_event",
			EventType: "process_stopped",
			Timestamp: time.Now().UnixMilli(),
			Priority:  "low",
			Payload: map[string]any{
				"pid":  p.pid,
				"name": p.name,
			},
		}
		if err := send(ctx, event, nil); err != nil {
			log.Printf("[processes] Failed to send process_stopped: %v", err)
		}
	}
}
