package main

// Coarse OS-version detection for telemetry. Best-effort and cached once per
// process (the exec/file read is cheap but we never repeat it per heartbeat).
// Returns "" on any failure — os_version is optional in the payload.

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

var (
	osVersionOnce   sync.Once
	osVersionCached string
)

func osVersion() string {
	osVersionOnce.Do(func() { osVersionCached = detectOSVersion() })
	return osVersionCached
}

func detectOSVersion() string {
	switch runtime.GOOS {
	case "darwin":
		// e.g. "darwin 14.5"
		if out, err := exec.Command("sw_vers", "-productVersion").Output(); err == nil {
			if v := strings.TrimSpace(string(out)); v != "" {
				return "darwin " + v
			}
		}
	case "linux":
		// Prefer the distro id + version from os-release, e.g. "ubuntu 22.04".
		if data, err := os.ReadFile("/etc/os-release"); err == nil {
			id, ver := "", ""
			for _, line := range strings.Split(string(data), "\n") {
				switch {
				case strings.HasPrefix(line, "ID="):
					id = unquoteOSRelease(strings.TrimPrefix(line, "ID="))
				case strings.HasPrefix(line, "VERSION_ID="):
					ver = unquoteOSRelease(strings.TrimPrefix(line, "VERSION_ID="))
				}
			}
			if combined := strings.TrimSpace(id + " " + ver); combined != "" {
				return combined
			}
		}
	case "windows":
		// `cmd /c ver` => "Microsoft Windows [Version 10.0.22631.4317]".
		if out, err := exec.Command("cmd", "/c", "ver").Output(); err == nil {
			s := strings.TrimSpace(string(out))
			if i := strings.Index(s, "[Version "); i >= 0 {
				v := strings.TrimSuffix(strings.TrimSpace(s[i+len("[Version "):]), "]")
				if v != "" {
					return "windows " + v
				}
			}
			return "windows"
		}
	}
	return ""
}

func unquoteOSRelease(s string) string {
	return strings.Trim(strings.TrimSpace(s), `"`)
}
