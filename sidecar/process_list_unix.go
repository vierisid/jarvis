//go:build !windows

package main

import (
	"os/exec"
	"strconv"
	"strings"
)

// platformListProcesses lists running processes via `ps`, using the same
// portable format the brain's ProcessMonitor used on Linux and macOS:
//
//	ps -axo pid=,pcpu=,pmem=,command=  ->  "PID %CPU %MEM COMMAND"
func platformListProcesses() ([]processInfo, error) {
	out, err := exec.Command("ps", "-axo", "pid=,pcpu=,pmem=,command=").Output()
	if err != nil {
		return nil, err
	}
	return parsePS(string(out)), nil
}

func parsePS(output string) []processInfo {
	var procs []processInfo
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Collapse runs of whitespace, then split into at most 4 fields so the
		// command (which may contain spaces) stays intact.
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		cpu, _ := strconv.ParseFloat(fields[1], 64)
		mem, _ := strconv.ParseFloat(fields[2], 64)
		name := strings.Join(fields[3:], " ")
		procs = append(procs, processInfo{PID: pid, Name: name, CPU: cpu, Memory: mem})
	}
	return procs
}
