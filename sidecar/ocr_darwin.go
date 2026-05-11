//go:build darwin

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// helperPath returns the absolute path to the ocr-helper Swift binary, which
// is expected to live next to the sidecar binary on disk.
func helperPath() string {
	exe, err := os.Executable()
	if err != nil {
		return "ocr-helper"
	}
	return filepath.Join(filepath.Dir(exe), "ocr-helper")
}

func platformOCR(imagePath string) (OCRResult, error) {
	start := time.Now()

	out, err := exec.Command(helperPath(), imagePath).Output()
	if err != nil {
		return OCRResult{}, fmt.Errorf("ocr-helper: %w", err)
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return OCRResult{}, fmt.Errorf("decode ocr-helper output: %w", err)
	}

	return OCRResult{
		Text:       result.Text,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

func checkOCR() string {
	if _, err := os.Stat(helperPath()); err != nil {
		return "ocr-helper binary not found alongside sidecar (build with: make build-ocr-helper on macOS)"
	}
	return ""
}
