package main

import (
	"os"
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

func TestSaveConfigRestrictsPermissions(t *testing.T) {
	originalConfigDir := configDir
	originalConfigFile := configFile
	t.Cleanup(func() {
		configDir = originalConfigDir
		configFile = originalConfigFile
	})

	configDir = filepath.Join(t.TempDir(), ".jarvis-sidecar")
	configFile = filepath.Join(configDir, "config.yaml")

	cfg := defaultConfig()
	cfg.Token = "secret-token"

	if err := SaveConfig(&cfg); err != nil {
		t.Fatalf("SaveConfig() error = %v", err)
	}

	dirInfo, err := os.Stat(configDir)
	if err != nil {
		t.Fatalf("stat config dir: %v", err)
	}
	if got := dirInfo.Mode().Perm(); got != 0700 {
		t.Fatalf("config dir mode = %o, want 0700", got)
	}

	fileInfo, err := os.Stat(configFile)
	if err != nil {
		t.Fatalf("stat config file: %v", err)
	}
	if got := fileInfo.Mode().Perm(); got != 0600 {
		t.Fatalf("config file mode = %o, want 0600", got)
	}
}

// TestSaveConfigRefusesSymlink verifies that O_NOFOLLOW prevents a hostile
// (or stale) symlink at configFile from redirecting the write to an
// unrelated target.
func TestSaveConfigRefusesSymlink(t *testing.T) {
	originalConfigDir := configDir
	originalConfigFile := configFile
	t.Cleanup(func() {
		configDir = originalConfigDir
		configFile = originalConfigFile
	})

	tmp := t.TempDir()
	configDir = filepath.Join(tmp, ".jarvis-sidecar")
	configFile = filepath.Join(configDir, "config.yaml")

	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	decoy := filepath.Join(tmp, "decoy.txt")
	if err := os.WriteFile(decoy, []byte("innocent"), 0600); err != nil {
		t.Fatalf("write decoy: %v", err)
	}
	if err := os.Symlink(decoy, configFile); err != nil {
		t.Skipf("symlink not supported on this platform: %v", err)
	}

	err := SaveConfig(&SidecarConfig{Token: "secret"})
	if err == nil {
		t.Fatal("SaveConfig should have failed on symlinked configFile")
	}

	data, readErr := os.ReadFile(decoy)
	if readErr != nil {
		t.Fatalf("read decoy: %v", readErr)
	}
	if string(data) != "innocent" {
		t.Fatalf("decoy was overwritten: got %q, want %q", data, "innocent")
	}
}
