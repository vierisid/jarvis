//go:build linux

package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestCheckOCRMatchesTesseractAvailability(t *testing.T) {
	_, lookErr := exec.LookPath("tesseract")
	reason := checkOCR()

	if lookErr == nil {
		// tesseract installed — checkOCR should report it as available.
		if reason != "" {
			t.Errorf("tesseract on PATH but checkOCR returned %q", reason)
		}
	} else {
		// tesseract missing — checkOCR should say so.
		if !strings.Contains(reason, "tesseract") {
			t.Errorf("expected reason to mention tesseract, got %q", reason)
		}
	}
}

func TestPlatformOCRRunsWhenTesseractAvailable(t *testing.T) {
	if _, err := exec.LookPath("tesseract"); err != nil {
		t.Skip("tesseract not installed — skipping live OCR test")
	}

	// We don't ship a sample PNG; smoke-test that platformOCR returns an
	// error for a non-existent path (i.e., the tesseract invocation happens
	// and propagates the failure).
	_, err := platformOCR("/nonexistent/jarvis-ocr-smoke.png")
	if err == nil {
		t.Fatal("expected error for nonexistent image path")
	}
}
