package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeLogFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func readLogFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// An oversized log is kept as the previous generation, not deleted: the relaunch
// after a crash is exactly when rotation runs, and the traceback is at the end
// of the file being rotated.
func TestRotateLogKeepsThePreviousGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), logFileName)
	writeLogFile(t, path+rotatedLogSuffix, "older generation")
	writeLogFile(t, path, "0123456789 panic: the traceback we need")

	rotateLog(path, 10)

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("current log should have moved aside, stat err = %v", err)
	}
	if got := readLogFile(t, path+rotatedLogSuffix); got != "0123456789 panic: the traceback we need" {
		t.Fatalf("rotated log = %q, want the file that was just rotated (replacing the older generation)", got)
	}
}

func TestRotateLogLeavesASmallLogAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), logFileName)
	writeLogFile(t, path, "short")

	rotateLog(path, 10)

	if got := readLogFile(t, path); got != "short" {
		t.Fatalf("log = %q, want it untouched", got)
	}
	if _, err := os.Stat(path + rotatedLogSuffix); !os.IsNotExist(err) {
		t.Fatalf("no rotated log expected, stat err = %v", err)
	}
}

func TestRotateLogWithNoLogYet(t *testing.T) {
	path := filepath.Join(t.TempDir(), logFileName)

	rotateLog(path, 10)

	if _, err := os.Stat(path + rotatedLogSuffix); !os.IsNotExist(err) {
		t.Fatalf("no rotated log expected, stat err = %v", err)
	}
}
