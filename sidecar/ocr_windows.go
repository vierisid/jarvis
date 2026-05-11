//go:build windows

package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

//go:embed ocr_windows.ps1
var winOCRScript string

// platformOCR runs Windows.Media.Ocr via a PowerShell script.
//
// PowerShell startup adds ~300-500ms per call. With a 7s capture cadence
// that's fine; for tighter loops port this to direct WinRT COM calls via
// go-ole following the pattern in uia_windows.go.
func platformOCR(imagePath string) (OCRResult, error) {
	start := time.Now()

	scriptFile := filepath.Join(os.TempDir(), fmt.Sprintf("jarvis-ocr-%d.ps1", start.UnixNano()))
	if err := os.WriteFile(scriptFile, []byte(winOCRScript), 0644); err != nil {
		return OCRResult{}, fmt.Errorf("write ocr script: %w", err)
	}
	defer os.Remove(scriptFile)

	out, err := exec.Command(
		"powershell",
		"-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-File", scriptFile,
		"-Path", imagePath,
	).Output()
	if err != nil {
		return OCRResult{}, fmt.Errorf("powershell ocr: %w", err)
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return OCRResult{}, fmt.Errorf("decode ocr output: %w", err)
	}

	return OCRResult{
		Text:       result.Text,
		DurationMs: time.Since(start).Milliseconds(),
	}, nil
}

func checkOCR() string {
	if _, err := exec.LookPath("powershell"); err != nil {
		return "powershell not found"
	}
	return ""
}
