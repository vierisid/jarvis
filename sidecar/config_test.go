package main

import (
	"os"
	"path/filepath"
	"strings"
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

	configDir = filepath.Join(t.TempDir(), ".jarvis")
	configFile = filepath.Join(configDir, "sidecar.yaml")

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
	configDir = filepath.Join(tmp, ".jarvis")
	configFile = filepath.Join(configDir, "sidecar.yaml")

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

// TestOpenDashboardAtStartupDefaultsOff locks in the off-by-default contract
// for the "Open dashboard at startup" preference: a config file written before
// the key existed must load as false, not pop a window on the user's next
// launch. Mirrors TestAwarenessOCRDefault, but the polarity is the point here —
// the zero value IS the default, so unlike telemetry this needs no pointer.
func TestOpenDashboardAtStartupDefaultsOff(t *testing.T) {
	cases := []struct {
		name string
		yaml string
		want bool
	}{
		{"no preferences block", "token: abc\n", false},
		{"preferences without the key", "preferences:\n  start_at_startup: true\n", false},
		{"explicit false", "preferences:\n  open_dashboard_at_startup: false\n", false},
		{"explicit true", "preferences:\n  open_dashboard_at_startup: true\n", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := defaultConfig()
			if cfg.Preferences.OpenDashboardAtStartup {
				t.Fatal("defaultConfig must leave open_dashboard_at_startup off")
			}
			if err := yaml.Unmarshal([]byte(tc.yaml), &cfg); err != nil {
				t.Fatalf("yaml: %v", err)
			}
			if cfg.Preferences.OpenDashboardAtStartup != tc.want {
				t.Fatalf("OpenDashboardAtStartup = %v, want %v", cfg.Preferences.OpenDashboardAtStartup, tc.want)
			}
		})
	}
}

// TestOpenDashboardAtStartupRoundTrips proves the toggle survives the on-disk
// write/read cycle (SaveConfig -> LoadConfig).
func TestOpenDashboardAtStartupRoundTrips(t *testing.T) {
	originalConfigDir := configDir
	originalConfigFile := configFile
	t.Cleanup(func() {
		configDir = originalConfigDir
		configFile = originalConfigFile
	})

	configDir = filepath.Join(t.TempDir(), ".jarvis")
	configFile = filepath.Join(configDir, "sidecar.yaml")

	cfg := defaultConfig()
	cfg.Preferences.OpenDashboardAtStartup = true
	if err := SaveConfig(&cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	loaded, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !loaded.Preferences.OpenDashboardAtStartup {
		t.Fatal("OpenDashboardAtStartup did not survive the save/load round trip")
	}
}

// withTempConfig points configDir/configFile at a temp dir for one test.
func withTempConfig(t *testing.T) {
	t.Helper()
	originalConfigDir := configDir
	originalConfigFile := configFile
	t.Cleanup(func() {
		configDir = originalConfigDir
		configFile = originalConfigFile
	})
	configDir = filepath.Join(t.TempDir(), ".jarvis")
	configFile = filepath.Join(configDir, "sidecar.yaml")
}

// A saved config must not spell out values that still match the defaults.
// Writing them is what freezes an install at whatever the defaults were on the
// day it enrolled, so a later change to a default can never reach it.
func TestSaveConfigOmitsDefaults(t *testing.T) {
	withTempConfig(t)

	cfg := defaultConfig()
	if err := SaveConfig(&cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	data, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}

	for _, key := range []string{
		"screen_interval_ms", "window_interval_ms", "min_change_threshold",
		"stuck_threshold_ms", "capture_dir", "timeout_ms", "max_file_size_kb", "cdp_port",
	} {
		if strings.Contains(string(data), key) {
			t.Errorf("saved config pins default %q:\n%s", key, data)
		}
	}
}

// The flip side: a deliberate non-default choice must survive the round trip.
func TestSaveConfigKeepsDeliberateValues(t *testing.T) {
	withTempConfig(t)

	cfg := defaultConfig()
	cfg.Awareness.ScreenIntervalMs = 3000
	cfg.Awareness.OCREnabled = false
	if err := SaveConfig(&cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	loaded, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if loaded.Awareness.ScreenIntervalMs != 3000 {
		t.Errorf("screen interval = %d, want 3000", loaded.Awareness.ScreenIntervalMs)
	}
	// A false bool is why OCREnabled is not omitempty: omitting it would read
	// back as the true default and silently switch OCR on again.
	if loaded.Awareness.OCREnabled {
		t.Error("ocr_enabled false did not survive the round trip")
	}
	// Untouched values still resolve to the current defaults.
	if loaded.Awareness.WindowIntervalMs != defaultWindowIntervalMs {
		t.Errorf("window interval = %d, want %d", loaded.Awareness.WindowIntervalMs, defaultWindowIntervalMs)
	}
}

// An install enrolled before the defaults changed has the old values written
// out verbatim. Those must read as "not specified" so the new default applies.
func TestLoadConfigIgnoresSupersededDefaults(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Exactly what a pre-0.9.4 sidecar.yaml carried.
	old := "awareness:\n  screen_interval_ms: 7000\n  window_interval_ms: 2000\n  min_change_threshold: 0.02\n  stuck_threshold_ms: 120000\n  ocr_enabled: true\n"
	if err := os.WriteFile(configFile, []byte(old), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Awareness.ScreenIntervalMs != defaultScreenIntervalMs {
		t.Errorf("screen interval = %d, want %d", cfg.Awareness.ScreenIntervalMs, defaultScreenIntervalMs)
	}
	if cfg.Awareness.WindowIntervalMs != defaultWindowIntervalMs {
		t.Errorf("window interval = %d, want %d", cfg.Awareness.WindowIntervalMs, defaultWindowIntervalMs)
	}
	if !cfg.Awareness.OCREnabled {
		t.Error("unrelated stored values must be untouched")
	}
}

// A value that happens to be non-default is never confused with a superseded
// one, even when it sits between the old and new defaults.
func TestLoadConfigKeepsNonDefaultIntervals(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(configFile, []byte("awareness:\n  screen_interval_ms: 9000\n"), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Awareness.ScreenIntervalMs != 9000 {
		t.Errorf("screen interval = %d, want 9000", cfg.Awareness.ScreenIntervalMs)
	}
}

// Loading a legacy file and saving it back leaves the file carrying no pinned
// defaults at all, so the next default change reaches this install too.
func TestLegacyConfigHealsOnSave(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(configFile, []byte("awareness:\n  screen_interval_ms: 7000\n  window_interval_ms: 2000\n"), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if err := SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	data, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(data), "screen_interval_ms") || strings.Contains(string(data), "window_interval_ms") {
		t.Errorf("rewritten config still pins intervals:\n%s", data)
	}
}

// The migration must not fire on a versioned file. 7000 is a legitimate choice
// today; once the file carries a stamp, that choice has to survive restarts.
func TestSupersededMigrationRunsOnlyOnUnversionedFiles(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	stamped := "config_version: 1\nawareness:\n  screen_interval_ms: 7000\n"
	if err := os.WriteFile(configFile, []byte(stamped), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.Awareness.ScreenIntervalMs != 7000 {
		t.Errorf("screen interval = %d, want 7000 (deliberate choice on a stamped file)", cfg.Awareness.ScreenIntervalMs)
	}
}

// Choosing the old default through the settings UI has to stick: save stamps
// the file, so the next load leaves it alone.
func TestDeliberateLegacyValueSurvivesRoundTrip(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Start from an unversioned file, as an existing install would.
	if err := os.WriteFile(configFile, []byte("awareness:\n  screen_interval_ms: 7000\n"), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	// Migrated to the new default on this first load.
	if cfg.Awareness.ScreenIntervalMs != defaultScreenIntervalMs {
		t.Fatalf("screen interval = %d, want %d", cfg.Awareness.ScreenIntervalMs, defaultScreenIntervalMs)
	}

	// Now the user deliberately picks 7s in the settings UI.
	cfg.Awareness.ScreenIntervalMs = 7000
	if err := SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	reloaded, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if reloaded.Awareness.ScreenIntervalMs != 7000 {
		t.Errorf("deliberate 7000 reverted to %d", reloaded.Awareness.ScreenIntervalMs)
	}
}

// Every save stamps the version, including one that pins nothing else.
func TestSaveConfigStampsVersion(t *testing.T) {
	withTempConfig(t)
	cfg := defaultConfig()
	if err := SaveConfig(&cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	data, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(data), "config_version: 1") {
		t.Errorf("saved config carries no version stamp:\n%s", data)
	}
}
