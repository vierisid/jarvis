package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectIANATimezoneTZEnv(t *testing.T) {
	t.Setenv("TZ", "Europe/Rome")
	if got := DetectIANATimezone(); got != "Europe/Rome" {
		t.Fatalf("TZ env should win, got %q", got)
	}

	// POSIX ":Area/City" form.
	t.Setenv("TZ", ":America/New_York")
	if got := DetectIANATimezone(); got != "America/New_York" {
		t.Fatalf("colon-prefixed TZ should be accepted, got %q", got)
	}

	// Garbage TZ must not be reported as an IANA name.
	t.Setenv("TZ", "/usr/share/zoneinfo/../evil")
	if got := DetectIANATimezone(); got == "/usr/share/zoneinfo/../evil" {
		t.Fatalf("garbage TZ leaked through: %q", got)
	}
}

func TestUnixIANATimezoneFromLocaltimeSymlink(t *testing.T) {
	dir := t.TempDir()
	// Fake zoneinfo tree with a real file so EvalSymlinks resolves.
	zoneFile := filepath.Join(dir, "zoneinfo", "Europe", "Rome")
	if err := os.MkdirAll(filepath.Dir(zoneFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(zoneFile, []byte("TZif"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "localtime")
	if err := os.Symlink(zoneFile, link); err != nil {
		t.Fatal(err)
	}

	if got := unixIANATimezone(link, filepath.Join(dir, "nope")); got != "Europe/Rome" {
		t.Fatalf("symlink resolution failed, got %q", got)
	}
}

func TestUnixIANATimezoneDebianFallback(t *testing.T) {
	dir := t.TempDir()
	tzFile := filepath.Join(dir, "timezone")
	if err := os.WriteFile(tzFile, []byte("Asia/Kolkata\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := unixIANATimezone(filepath.Join(dir, "missing"), tzFile); got != "Asia/Kolkata" {
		t.Fatalf("/etc/timezone fallback failed, got %q", got)
	}
}

func TestUnixIANATimezoneUnknown(t *testing.T) {
	dir := t.TempDir()
	if got := unixIANATimezone(filepath.Join(dir, "a"), filepath.Join(dir, "b")); got != "" {
		t.Fatalf("expected empty for unknown, got %q", got)
	}
}

func TestWindowsZoneMapSpotChecks(t *testing.T) {
	cases := map[string]string{
		"W. Europe Standard Time": "Europe/Berlin",
		"Eastern Standard Time":   "America/New_York",
		"India Standard Time":     "Asia/Kolkata",
		"UTC":                     "Etc/UTC",
	}
	for win, iana := range cases {
		if got := windowsZoneToIANA[win]; got != iana {
			t.Errorf("%s -> %q, want %q", win, got, iana)
		}
	}
	// Every mapped value must look like an IANA name.
	for win, iana := range windowsZoneToIANA {
		if !ianaNameRe.MatchString(iana) {
			t.Errorf("map entry %q has non-IANA value %q", win, iana)
		}
	}
}
