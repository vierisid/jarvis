//go:build linux

package main

import (
	"errors"
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

// The combo goes after "--" and ends in "+": libxdo skips the empty last key,
// and no xdotool command name contains "+", so `xdotool key` cannot chain
// into a command whatever the combo is.
func TestPressKeysPassesComboToXdotoolAfterDoubleDash(t *testing.T) {
	lastArgv := fakeXdotool(t)
	for keys, combo := range map[string]string{
		"ctrl,s":     "ctrl+s",
		"enter":      "Return",
		"alt,f4":     "alt+F4",
		"ctrl,shift": "ctrl+shift",
		"ctrl+s":     "ctrl+s",
		"minus":      "minus",
		"Help":       "Help",
	} {
		t.Run(keys, func(t *testing.T) {
			if _, err := handlePressKeys(map[string]any{"keys": keys}); err != nil {
				t.Fatalf("press_keys %q: %v", keys, err)
			}
			want := []string{"key", "--", combo + "+"}
			if got := lastArgv(); !reflect.DeepEqual(got, want) {
				t.Errorf("press_keys %q ran xdotool %q, want %q", keys, got, want)
			}
		})
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
		"a,b,c,d,e,f,g,h,i",
	} {
		t.Run(keys, func(t *testing.T) {
			_, err := handlePressKeys(map[string]any{"keys": keys})
			// Refused before xdotool ran, and said so: the daemon reports
			// DESKTOP_INVALID_KEYS as not started (sidecar-route.ts).
			var coded *codedError
			if !errors.As(err, &coded) || coded.code != "DESKTOP_INVALID_KEYS" {
				t.Errorf("press_keys %q: got error %v, want a DESKTOP_INVALID_KEYS refusal", keys, err)
			} else if !strings.Contains(err.Error(), "nothing was pressed") {
				t.Errorf("press_keys %q: refusal %q does not say nothing was pressed", keys, err)
			}
			if got := lastArgv(); got != nil {
				t.Errorf("press_keys %q ran xdotool %q", keys, got)
			}
		})
	}
}

func TestCheckXdotoolKeySequence(t *testing.T) {
	for _, ok := range []string{"ctrl+s", "Return", "super+F5", "XF86AudioPlay", "U20AC", "0x61", "ctrl++s", "ctrl+Help", "ctrl+exec", "Help", "a+b+c+d+e+f+g+h"} {
		if err := checkXdotoolKeySequence(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "+", "-h", "--help", "ctrl+-", "a b", "slash/", "é", "exec", "EXEC", "help", "HELP", "a+b+c+d+e+f+g+h+i", "a+b+c+d+e+f+g+h+i+j"} {
		if err := checkXdotoolKeySequence(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	// Names are checked before the count, as the daemon does.
	if err := checkXdotoolKeySequence("a+b+c+d+e+f+g+h+-i"); err == nil || !strings.Contains(err.Error(), "invalid key name") {
		t.Errorf("9 keys with a bad name: got %v, want the invalid name reported", err)
	}
}
