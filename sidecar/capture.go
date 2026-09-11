package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

// saveCaptureToFile writes a PNG to {captureDir}/{YYYY-MM-DD}/{HH-MM-SS}.png
// and returns the full path. Creates parent directories as needed.
//
// Captures are screenshots of whatever the user had on screen, so they are
// private to this user (0700 directories, 0600 files). Modes are a no-op on
// Windows, where the user profile is already private.
func saveCaptureToFile(captureDir string, imageData []byte, ts time.Time) (string, error) {
	dateDir := ts.Format("2006-01-02")
	fileName := ts.Format("15-04-05") + ".png"
	dir := filepath.Join(captureDir, dateDir)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("mkdir capture dir: %w", err)
	}
	// Best effort: tighten a date dir created by an older build with 0755.
	// The root is left alone: it may be a user-chosen, shared location.
	_ = os.Chmod(dir, 0700)
	fullPath := filepath.Join(dir, fileName)
	if err := os.WriteFile(fullPath, imageData, 0600); err != nil {
		return "", fmt.Errorf("write capture: %w", err)
	}
	return fullPath, nil
}

// deleteCapturesBefore removes capture files under captureDir whose mtime is
// before cutoff, then removes date directories left empty. A missing capture
// dir is not an error. Shared by the brain-driven cleanup_captures RPC and the
// sidecar's own retention sweep.
func deleteCapturesBefore(captureDir string, cutoff time.Time) (filesDeleted, dirsRemoved int, err error) {
	entries, err := os.ReadDir(captureDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("read capture dir: %w", err)
	}

	for _, dateEntry := range entries {
		if !dateEntry.IsDir() {
			continue
		}
		dateDir := filepath.Join(captureDir, dateEntry.Name())
		files, err := os.ReadDir(dateDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() {
				continue
			}
			p := filepath.Join(dateDir, f.Name())
			info, err := f.Info()
			if err != nil {
				continue
			}
			if info.ModTime().Before(cutoff) {
				if err := os.Remove(p); err == nil {
					filesDeleted++
				}
			}
		}
		if remaining, _ := os.ReadDir(dateDir); len(remaining) == 0 {
			if err := os.Remove(dateDir); err == nil {
				dirsRemoved++
			}
		}
	}
	return filesDeleted, dirsRemoved, nil
}

// pruneCapturesOlderThan is the sidecar's own retention floor, applied
// regardless of what the brain does with cleanup_captures.
func pruneCapturesOlderThan(captureDir string, ttl time.Duration) (filesDeleted, dirsRemoved int, err error) {
	if ttl <= 0 {
		return 0, 0, nil
	}
	return deleteCapturesBefore(captureDir, time.Now().Add(-ttl))
}

// captureTTL resolves the configured retention: zero means the default,
// negative disables the sweep.
func captureTTL(cfg *SidecarConfig) time.Duration {
	hours := cfg.Awareness.CaptureTTLHours
	if hours == 0 {
		hours = defaultCaptureTTLHours
	}
	if hours < 0 {
		return 0
	}
	return time.Duration(hours) * time.Hour
}

// startCaptureRetention sweeps the capture dir once now and then hourly for
// the life of the process, independent of the brain connection and of the
// awareness capability. The values are snapshotted here; a TTL changed via
// update_config is picked up by the screen observer's own sweep, which the
// config reload restarts.
func startCaptureRetention(cfg *SidecarConfig) {
	ttl := captureTTL(cfg)
	dir := cfg.Awareness.CaptureDir
	if ttl <= 0 || dir == "" {
		return
	}
	sweep := func() {
		files, dirs, err := pruneCapturesOlderThan(dir, ttl)
		if err != nil {
			log.Printf("[captures] retention sweep failed: %v", err)
			return
		}
		if files > 0 || dirs > 0 {
			log.Printf("[captures] retention: removed %d file(s), %d empty dir(s) older than %s", files, dirs, ttl)
		}
	}
	go func() {
		sweep()
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for range t.C {
			sweep()
		}
	}()
}
