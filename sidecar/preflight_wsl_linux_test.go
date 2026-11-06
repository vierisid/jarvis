//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// #1159: a Linux sidecar enrolled inside WSL advertised screenshot, desktop
// and awareness, then captured WSLg's empty screen until the brain's #901
// refusal. Inside WSL they are reported unavailable, with the reason.
func TestPreflightReportsScreenAndDesktopUnavailableInsideWSL(t *testing.T) {
	dir := t.TempDir()
	prev := procVersionPath
	t.Cleanup(func() { procVersionPath = prev })
	write := func(content string) {
		procVersionPath = filepath.Join(dir, "version")
		if err := os.WriteFile(procVersionPath, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Display and tools present, so only WSL can make them unavailable.
	t.Setenv("DISPLAY", ":0")
	t.Setenv("WAYLAND_DISPLAY", "")
	bin := t.TempDir()
	for _, tool := range []string{"scrot", "xdotool"} {
		if err := os.WriteFile(filepath.Join(bin, tool), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin)

	gated := []SidecarCapability{CapScreenshot, CapAwareness, CapDesktop}
	cfg := &SidecarConfig{Capabilities: append(append([]SidecarCapability{}, gated...), CapFilesystem)}

	for _, tc := range []struct {
		name, version string
		wsl           bool
	}{
		{"WSL2", "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@x) (gcc) #1 SMP", true},
		{"WSL1", "Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0) #1237-Microsoft", true},
		{"plain linux", "Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075) (x86_64-linux-gnu-gcc-13) #45-Ubuntu SMP", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			write(tc.version)
			available, unavailable := CheckCapabilities(cfg)
			reasons := map[SidecarCapability]string{}
			for _, u := range unavailable {
				reasons[u.Name] = u.Reason
			}
			for _, c := range gated {
				if tc.wsl && reasons[c] == "" {
					t.Errorf("%s advertised inside WSL", c)
				}
				if !tc.wsl && reasons[c] != "" {
					t.Errorf("%s unavailable outside WSL: %s", c, reasons[c])
				}
			}
			if !containsCap(available, CapFilesystem) {
				t.Errorf("filesystem should stay available: %v", available)
			}
		})
	}

	// No /proc/version (a sandbox) is not WSL.
	procVersionPath = filepath.Join(dir, "missing")
	if r := wslReason(); r != "" {
		t.Errorf("missing /proc/version read as WSL: %s", r)
	}
}

func containsCap(caps []SidecarCapability, c SidecarCapability) bool {
	for _, x := range caps {
		if x == c {
			return true
		}
	}
	return false
}
