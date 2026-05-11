package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveCaptureToFile(t *testing.T) {
	dir := t.TempDir()
	captureDir := filepath.Join(dir, "captures")
	data := []byte("\x89PNG\r\n\x1a\nfake-payload")
	ts := time.Date(2026, 5, 11, 14, 30, 22, 0, time.UTC)

	got, err := saveCaptureToFile(captureDir, data, ts)
	if err != nil {
		t.Fatalf("saveCaptureToFile: %v", err)
	}

	want := filepath.Join(captureDir, "2026-05-11", "14-30-22.png")
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}

	read, err := os.ReadFile(got)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(read, data) {
		t.Fatalf("payload mismatch: got %q, want %q", read, data)
	}
}

func TestSaveCaptureToFileMkdirNested(t *testing.T) {
	// Parent dirs don't exist — saveCaptureToFile should create them.
	dir := t.TempDir()
	captureDir := filepath.Join(dir, "deep", "down", "captures")
	_, err := saveCaptureToFile(captureDir, []byte("x"), time.Now())
	if err != nil {
		t.Fatalf("saveCaptureToFile: %v", err)
	}
}
