//go:build darwin

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

	cmd := exec.Command(helperPath(), imagePath)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return OCRResult{}, fmt.Errorf("ocr-helper: %s", msg)
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		details := strings.TrimSpace(stderr.String())
		if details != "" {
			return OCRResult{}, fmt.Errorf("decode ocr-helper output (%s): %w", details, err)
		}
		return OCRResult{}, fmt.Errorf("decode ocr-helper output: %w (raw: %q)", err, stdout.String())
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
