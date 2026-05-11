package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ── fetch_capture ───────────────────────────────────────────────────────

func TestFetchCaptureReadsValidPath(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.Awareness.CaptureDir = dir

	payload := []byte("\x89PNG\r\n\x1a\nfake-png-bytes")
	imgPath, err := saveCaptureToFile(dir, payload, time.Now())
	if err != nil {
		t.Fatalf("saveCaptureToFile: %v", err)
	}

	h := makeFetchCaptureHandler(cfg)
	result, err := h(map[string]any{"path": imgPath})
	if err != nil {
		t.Fatalf("fetch_capture: %v", err)
	}

	inline, ok := result.Binary.(BinaryDataInline)
	if !ok {
		t.Fatalf("expected BinaryDataInline, got %T", result.Binary)
	}
	if inline.MimeType != "image/png" {
		t.Errorf("mime = %q, want image/png", inline.MimeType)
	}

	decoded, err := base64.StdEncoding.DecodeString(inline.Data)
	if err != nil {
		t.Fatalf("base64 decode: %v", err)
	}
	if string(decoded) != string(payload) {
		t.Errorf("payload mismatch")
	}
}

func TestFetchCaptureRejectsOutsideDir(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.Awareness.CaptureDir = filepath.Join(dir, "captures")
	_ = os.MkdirAll(cfg.Awareness.CaptureDir, 0755)

	// File exists OUTSIDE CaptureDir.
	outside := filepath.Join(dir, "secret.png")
	if err := os.WriteFile(outside, []byte("classified"), 0644); err != nil {
		t.Fatal(err)
	}

	h := makeFetchCaptureHandler(cfg)
	if _, err := h(map[string]any{"path": outside}); err == nil {
		t.Fatal("expected error for path outside capture dir")
	}
}

func TestFetchCaptureMissingPathParam(t *testing.T) {
	h := makeFetchCaptureHandler(testConfig())
	if _, err := h(map[string]any{}); err == nil {
		t.Fatal("expected error when path is missing")
	}
}

// ── cleanup_captures ────────────────────────────────────────────────────

func TestCleanupCapturesDeletesOldFiles(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.Awareness.CaptureDir = dir

	// Create one old file and one fresh file.
	oldTs := time.Now().Add(-2 * time.Hour)
	freshTs := time.Now()
	oldPath, err := saveCaptureToFile(dir, []byte("old"), oldTs)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(oldPath, oldTs, oldTs); err != nil {
		t.Fatal(err)
	}
	freshPath, err := saveCaptureToFile(dir, []byte("fresh"), freshTs)
	if err != nil {
		t.Fatal(err)
	}

	cutoffMs := float64(time.Now().Add(-1 * time.Hour).UnixMilli())
	h := makeCleanupCapturesHandler(cfg)
	result, err := h(map[string]any{"before_ms": cutoffMs})
	if err != nil {
		t.Fatalf("cleanup_captures: %v", err)
	}

	m := result.Result.(map[string]any)
	if m["files_deleted"].(int) < 1 {
		t.Errorf("expected at least 1 file deleted, got %v", m["files_deleted"])
	}

	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Errorf("expected old file to be removed, stat err = %v", err)
	}
	if _, err := os.Stat(freshPath); err != nil {
		t.Errorf("fresh file should remain: %v", err)
	}
}

func TestCleanupCapturesRejectsFutureCutoff(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig()
	cfg.Awareness.CaptureDir = dir

	h := makeCleanupCapturesHandler(cfg)
	// 10 minutes in the future — must be rejected.
	future := float64(time.Now().Add(10 * time.Minute).UnixMilli())
	if _, err := h(map[string]any{"before_ms": future}); err == nil {
		t.Fatal("expected error for future cutoff")
	}
}

func TestCleanupCapturesMissingDir(t *testing.T) {
	cfg := testConfig()
	cfg.Awareness.CaptureDir = filepath.Join(t.TempDir(), "nonexistent")

	h := makeCleanupCapturesHandler(cfg)
	result, err := h(map[string]any{"before_ms": float64(time.Now().Add(-1 * time.Hour).UnixMilli())})
	if err != nil {
		t.Fatalf("expected no error for missing dir, got: %v", err)
	}
	m := result.Result.(map[string]any)
	if m["files_deleted"].(int) != 0 {
		t.Errorf("files_deleted = %v, want 0", m["files_deleted"])
	}
}
