package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// saveCaptureToFile writes a PNG to {captureDir}/{YYYY-MM-DD}/{HH-MM-SS}.png
// and returns the full path. Creates parent directories as needed.
func saveCaptureToFile(captureDir string, imageData []byte, ts time.Time) (string, error) {
	dateDir := ts.Format("2006-01-02")
	fileName := ts.Format("15-04-05") + ".png"
	dir := filepath.Join(captureDir, dateDir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("mkdir capture dir: %w", err)
	}
	fullPath := filepath.Join(dir, fileName)
	if err := os.WriteFile(fullPath, imageData, 0644); err != nil {
		return "", fmt.Errorf("write capture: %w", err)
	}
	return fullPath, nil
}
