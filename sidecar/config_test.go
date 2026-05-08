package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
