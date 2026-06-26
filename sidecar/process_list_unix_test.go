//go:build !windows

package main

import "testing"

func TestParsePS(t *testing.T) {
	out := `  123  1.5  0.3 /usr/bin/firefox --profile foo
  456  0.0  0.1 bash
short line
  789  2.0  0.5 my app with spaces
`
	procs := parsePS(out)
	if len(procs) != 3 {
		t.Fatalf("expected 3 processes, got %d: %+v", len(procs), procs)
	}

	if procs[0].PID != 123 || procs[0].CPU != 1.5 || procs[0].Memory != 0.3 ||
		procs[0].Name != "/usr/bin/firefox --profile foo" {
		t.Fatalf("first process wrong: %+v", procs[0])
	}
	if procs[1].PID != 456 || procs[1].Name != "bash" {
		t.Fatalf("second process wrong: %+v", procs[1])
	}
	if procs[2].PID != 789 || procs[2].Name != "my app with spaces" {
		t.Fatalf("third process wrong (command with spaces): %+v", procs[2])
	}
}
