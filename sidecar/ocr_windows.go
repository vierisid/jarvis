//go:build windows

package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

	cmd := exec.Command(
		"powershell",
		"-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-File", scriptFile,
		"-Path", imagePath,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return OCRResult{}, fmt.Errorf("powershell ocr: %s", msg)
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		// Surface stderr too — strict-mode failures may print there even on exit 0.
		details := strings.TrimSpace(stderr.String())
		if details != "" {
			return OCRResult{}, fmt.Errorf("decode ocr output (%s): %w", details, err)
		}
		return OCRResult{}, fmt.Errorf("decode ocr output: %w (raw: %q)", err, stdout.String())
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
