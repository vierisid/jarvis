package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFreshConfigHasDefaultBlockedPaths(t *testing.T) {
	withTempConfig(t)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if len(cfg.Filesystem.BlockedPaths) == 0 {
		t.Fatal("fresh config must carry the default blocklist")
	}
	if cfg.Awareness.CaptureTTLHours != defaultCaptureTTLHours {
		t.Errorf("capture ttl = %d, want %d", cfg.Awareness.CaptureTTLHours, defaultCaptureTTLHours)
	}
}

// Every release before config version 2 wrote `blocked_paths: []`. That is
// the old default, not a decision, so the migration fills it in once.
func TestPreV2EmptyBlockedPathsMigratesToDefaults(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		"filesystem:\n  blocked_paths: []\n",
		"config_version: 1\nfilesystem:\n  blocked_paths: []\n",
	} {
		if err := os.WriteFile(configFile, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		cfg, err := LoadConfig()
		if err != nil {
			t.Fatalf("LoadConfig: %v", err)
		}
		if len(cfg.Filesystem.BlockedPaths) == 0 {
			t.Errorf("pre-2 file %q should get the default blocklist", body)
		}
		if cfg.ConfigVersion != currentConfigVersion {
			t.Errorf("version = %d, want %d", cfg.ConfigVersion, currentConfigVersion)
		}
	}
}

// A pre-2 install that had customised the list keeps its entries AND gains
// the defaults: nothing in a pre-2 list can be a decision against a default
// that did not exist yet.
func TestPreV2CustomBlockedPathsGainDefaults(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatal(err)
	}
	custom := filepath.Join(homeDir(), "finance")
	body := "config_version: 1\nfilesystem:\n  blocked_paths:\n    - " + custom + "\n    - ~/.ssh\n"
	if err := os.WriteFile(configFile, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	got := cfg.Filesystem.BlockedPaths
	if got[0] != custom {
		t.Errorf("user entries must come first and survive: %v", got)
	}
	if len(got) != len(defaultBlockedPaths())+1 {
		t.Errorf("expected custom + defaults without the duplicate ~/.ssh, got %d entries: %v", len(got), got)
	}
	count := 0
	for _, p := range got {
		if canonicalPath(p) == canonicalPath("~/.ssh") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("~/.ssh present %d times, want 1", count)
	}
}

func TestV2EmptyBlockedPathsIsRespected(t *testing.T) {
	withTempConfig(t)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatal(err)
	}
	body := "config_version: 2\nfilesystem:\n  blocked_paths: []\n"
	if err := os.WriteFile(configFile, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if len(cfg.Filesystem.BlockedPaths) != 0 {
		t.Error("an explicit empty list in a v2 file is the user's choice")
	}
}

func TestBlockedPathsAndTTLRoundTrip(t *testing.T) {
	withTempConfig(t)
	cfg := defaultConfig()
	cfg.Filesystem.BlockedPaths = []string{filepath.Join(homeDir(), "private")}
	cfg.Awareness.CaptureTTLHours = 6
	if err := SaveConfig(&cfg); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(configFile)
	if !strings.Contains(string(raw), "private") {
		t.Error("blocked_paths must be written verbatim")
	}
	if !strings.Contains(string(raw), "capture_ttl_hours: 6") {
		t.Error("non-default ttl must be written")
	}
	loaded, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Filesystem.BlockedPaths) != 1 || loaded.Awareness.CaptureTTLHours != 6 {
		t.Errorf("round trip lost values: %+v %d", loaded.Filesystem.BlockedPaths, loaded.Awareness.CaptureTTLHours)
	}

	// The default TTL is sparse on disk.
	cfg.Awareness.CaptureTTLHours = defaultCaptureTTLHours
	if err := SaveConfig(&cfg); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(configFile)
	if strings.Contains(string(raw), "capture_ttl_hours") {
		t.Error("default ttl must be omitted from the file")
	}
}
