//go:build linux

package main

import (
	"fmt"
	"os/exec"
	"time"
)

func platformOCR(imagePath string) (OCRResult, error) {
	start := time.Now()

	out, err := exec.Command("tesseract", imagePath, "stdout", "--psm", "3", "-l", "eng").Output()
	if err != nil {
		return OCRResult{}, fmt.Errorf("tesseract: %w", err)
	}

	return OCRResult{
		Text:       string(out),
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

func checkOCR() string {
	if _, err := exec.LookPath("tesseract"); err != nil {
		return "tesseract not found (install: apt install tesseract-ocr)"
	}
	return ""
}
