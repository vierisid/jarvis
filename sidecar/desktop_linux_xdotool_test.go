//go:build linux

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Text and key names come from the model. xdotool reads a leading "-" as an
// option, and `xdotool type --file=PATH` types out PATH (#518), so each of
// these must reach xdotool as data.
var hostileXdotoolText = []string{
	"--file=/etc/passwd",
	"-file=/etc/passwd",
	"--fi=/etc/passwd",
	"-h",
	"--help",
	"--window 1",
	"--delay 99999",
	"--delay=99999",
	"--terminator=x",
	"--",
	"-",
	// Legitimate text that happens to start with "-" is typed, not refused.
	"- item",
	"-5 degrees",
	"hello world",
}

// fakeXdotool puts a recording xdotool first and alone on PATH, so the real
// one can never run, and returns a function that reads the argv of the last
// call (nil when xdotool was not run).
func fakeXdotool(t *testing.T) func() []string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\000' \"$a\"; done > '" + log + "'\n"
	if err := os.WriteFile(filepath.Join(dir, "xdotool"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("DISPLAY", "")
	return func() []string {
		raw, err := os.ReadFile(log)
		if err != nil {
			return nil
		}
		os.Remove(log)
		return strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
	}
}

func TestTypeTextPassesTextToXdotoolAfterDoubleDash(t *testing.T) {
	lastArgv := fakeXdotool(t)
	for _, text := range hostileXdotoolText {
		if _, err := handleTypeText(map[string]any{"text": text}); err != nil {
			t.Errorf("type_text %q: %v", text, err)
			continue
		}
		want := []string{"type", "--delay", "12", "--", text}
		if got := lastArgv(); !reflect.DeepEqual(got, want) {
			t.Errorf("type_text %q ran xdotool %q, want %q", text, got, want)
		}
	}
}

func TestPressKeysPassesComboToXdotoolAfterDoubleDash(t *testing.T) {
	lastArgv := fakeXdotool(t)
	for keys, combo := range map[string]string{
		"ctrl,s":     "ctrl+s",
		"enter":      "Return",
		"alt,f4":     "alt+F4",
		"ctrl,shift": "ctrl+shift",
		"ctrl+s":     "ctrl+s",
		"minus":      "minus",
	} {
		if _, err := handlePressKeys(map[string]any{"keys": keys}); err != nil {
			t.Errorf("press_keys %q: %v", keys, err)
			continue
		}
		want := []string{"key", "--", combo}
		if got := lastArgv(); !reflect.DeepEqual(got, want) {
			t.Errorf("press_keys %q ran xdotool %q, want %q", keys, got, want)
		}
	}
}

func TestPressKeysRefusesOptionAndCommandNamesWithoutRunningXdotool(t *testing.T) {
	lastArgv := fakeXdotool(t)
	for _, keys := range []string{
		"--file=/etc/passwd",
		"-h",
		"--window=1",
		"--delay=99999",
		"ctrl,--repeat=500",
		"ctrl,-",
		"exec",
		"selectwindow",
		",",
	} {
		if _, err := handlePressKeys(map[string]any{"keys": keys}); err == nil {
			t.Errorf("press_keys %q was accepted", keys)
		}
		if got := lastArgv(); got != nil {
			t.Errorf("press_keys %q ran xdotool %q", keys, got)
		}
	}
}

func TestCheckXdotoolKeySequence(t *testing.T) {
	for _, ok := range []string{"ctrl+s", "Return", "super+F5", "XF86AudioPlay", "U20AC", "0x61", "ctrl++s", "ctrl+Help"} {
		if err := checkXdotoolKeySequence(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	if err := checkXdotoolKeySequence("a+b+c+d+e+f+g+h"); err != nil {
		t.Errorf("an 8-key combo was refused: %v", err)
	}
	for _, bad := range []string{"", "+", "-h", "--help", "ctrl+-", "a b", "slash/", "é", "exec", "EXEC", "help", "Help", "a+b+c+d+e+f+g+h+i+j"} {
		if err := checkXdotoolKeySequence(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
