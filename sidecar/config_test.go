package main

import (
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestAwarenessOCRDefault locks in the YAML-unmarshal-onto-defaults behavior.
// When a config file omits ocr_enabled, OCREnabled must remain true (the
// declared default in defaultConfig), not silently flip to false.
func TestAwarenessOCRDefault(t *testing.T) {
	cases := []struct {
		name string
		yaml string
		want bool
	}{
		{"omitted", "awareness:\n  screen_interval_ms: 5000\n", true},
		{"explicit true", "awareness:\n  ocr_enabled: true\n", true},
		{"explicit false", "awareness:\n  ocr_enabled: false\n", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := defaultConfig()
			if !cfg.Awareness.OCREnabled {
				t.Fatal("defaultConfig should enable OCR")
			}
			if err := yaml.Unmarshal([]byte(tc.yaml), &cfg); err != nil {
				t.Fatalf("yaml: %v", err)
			}
			if cfg.Awareness.OCREnabled != tc.want {
				t.Fatalf("OCREnabled = %v, want %v", cfg.Awareness.OCREnabled, tc.want)
			}
		})
	}
}

func TestAwarenessCaptureDirDefault(t *testing.T) {
	cfg := defaultConfig()
	want := filepath.Join(homeDir(), ".jarvis", "captures")
	if cfg.Awareness.CaptureDir != want {
		t.Fatalf("CaptureDir = %q, want %q", cfg.Awareness.CaptureDir, want)
	}
}
