//go:build sidecartest

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// runTests is the platform-test entry point compiled in when the binary is
// built with `-tags sidecartest`. It dispatches a small set of subcommands
// that exercise capabilities CI cannot reach (Vision on macOS, WinRT on
// Windows, real screen capture, etc.). Operator workflow:
//
//   make build-test                         # produces jarvis-sidecar-test
//   scp jarvis-sidecar-test mac:~/          # or windows:
//   ./jarvis-sidecar-test --test capture    # exercises full save + OCR loop
func runTests(args []string) int {
	if len(args) == 0 {
		printTestHelp()
		return 1
	}

	switch args[0] {
	case "help":
		printTestHelp()
		return 0
	case "preflight":
		return testPreflight()
	case "ocr":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: --test ocr <image-path>")
			return 2
		}
		return testOCR(args[1])
	case "capture":
		return testCapture()
	case "all":
		rc := 0
		if r := testPreflight(); r != 0 {
			rc = r
		}
		if r := testCapture(); r != 0 {
			rc = r
		}
		return rc
	default:
		fmt.Fprintf(os.Stderr, "unknown test subcommand: %q\n", args[0])
		printTestHelp()
		return 2
	}
}

func printTestHelp() {
	fmt.Printf(`jarvis-sidecar platform test runner (built %s/%s)

Usage:
  jarvis-sidecar --test help                  This text
  jarvis-sidecar --test preflight             Print capability availability + reasons
  jarvis-sidecar --test ocr <image-path>      Run platformOCR against a PNG
  jarvis-sidecar --test capture               Live screen capture -> save -> OCR
  jarvis-sidecar --test all                   preflight + capture (no path needed)
`, runtime.GOOS, runtime.GOARCH)
}

func testPreflight() int {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}
	available, unavailable := CheckCapabilities(cfg)

	fmt.Println("Available capabilities:")
	for _, c := range available {
		fmt.Printf("  + %s\n", c)
	}
	if len(unavailable) > 0 {
		fmt.Println("Unavailable capabilities:")
		for _, u := range unavailable {
			fmt.Printf("  - %s — %s\n", u.Name, u.Reason)
		}
	}
	return 0
}

func testOCR(imagePath string) int {
	if _, err := os.Stat(imagePath); err != nil {
		fmt.Fprintf(os.Stderr, "image not found: %v\n", err)
		return 1
	}
	if r := checkOCR(); r != "" {
		fmt.Fprintf(os.Stderr, "ocr unavailable: %s\n", r)
		return 1
	}

	fmt.Printf("Running platformOCR on %s ...\n", imagePath)
	result, err := platformOCR(imagePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "platformOCR failed: %v\n", err)
		return 1
	}

	fmt.Printf("Duration:   %dms\n", result.DurationMs)
	fmt.Printf("Text chars: %d\n", len(result.Text))
	fmt.Println("---")
	fmt.Println(strings.TrimRight(result.Text, "\n"))
	fmt.Println("---")
	return 0
}

func testCapture() int {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config: %v\n", err)
		return 1
	}

	captureDir := cfg.Awareness.CaptureDir
	if captureDir == "" {
		captureDir = filepath.Join(os.TempDir(), "jarvis-sidecar-test-captures")
	}
	fmt.Printf("Capture dir: %s\n", captureDir)

	t0 := time.Now()
	data, err := captureScreenBytes()
	if err != nil {
		fmt.Fprintf(os.Stderr, "captureScreenBytes failed: %v\n", err)
		return 1
	}
	captureMs := time.Since(t0).Milliseconds()
	fmt.Printf("Captured %d bytes in %dms\n", len(data), captureMs)

	t1 := time.Now()
	imagePath, err := saveCaptureToFile(captureDir, data, time.Now())
	if err != nil {
		fmt.Fprintf(os.Stderr, "saveCaptureToFile failed: %v\n", err)
		return 1
	}
	saveMs := time.Since(t1).Milliseconds()
	fmt.Printf("Saved to %s in %dms\n", imagePath, saveMs)

	if r := checkOCR(); r != "" {
		fmt.Printf("OCR unavailable (%s) — capture+save validated, skipping OCR\n", r)
		return 0
	}

	t2 := time.Now()
	result, err := platformOCR(imagePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "platformOCR failed: %v\n", err)
		return 1
	}
	totalMs := time.Since(t0).Milliseconds()

	fmt.Printf("OCR: %d chars in %dms (reported %dms)\n", len(result.Text), time.Since(t2).Milliseconds(), result.DurationMs)
	fmt.Printf("Total pipeline: %dms (target <7000ms)\n", totalMs)
	preview := strings.TrimSpace(result.Text)
	if len(preview) > 200 {
		preview = preview[:200] + "..."
	}
	fmt.Println("---")
	fmt.Println(preview)
	fmt.Println("---")
	return 0
}
