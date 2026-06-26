//go:build windows

package main

import (
	"encoding/csv"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// platformListProcesses lists running processes via PowerShell Get-Process,
// matching the brain's old ProcessMonitor (Id, Name, CPU, WorkingSet as CSV).
func platformListProcesses() ([]processInfo, error) {
	cmd := exec.Command(
		"powershell", "-NoProfile", "-Command",
		"Get-Process | Select-Object Id,Name,CPU,WorkingSet | ConvertTo-Csv -NoTypeInformation",
	)
	hideSubprocessWindow(cmd) // GUI build: don't flash a console window every poll
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return parseWindowsProcessCSV(string(out)), nil
}

func parseWindowsProcessCSV(output string) []processInfo {
	r := csv.NewReader(strings.NewReader(output))
	r.FieldsPerRecord = -1

	var procs []processInfo
	first := true
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue
		}
		if first {
			// Header row: Id,Name,CPU,WorkingSet
			first = false
			continue
		}
		if len(rec) < 4 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(rec[0]))
		if err != nil {
			continue
		}
		cpu, _ := strconv.ParseFloat(strings.TrimSpace(rec[2]), 64)
		mem, _ := strconv.ParseFloat(strings.TrimSpace(rec[3]), 64)
		procs = append(procs, processInfo{PID: pid, Name: rec[1], CPU: cpu, Memory: mem})
	}
	return procs
}
