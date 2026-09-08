//go:build windows

package main

import (
	"strings"
	"syscall"
	"testing"
)

// A registration the OS refuses has to come back as an ERROR.
//
// It used to be logged from inside the listener goroutine while
// startHotkeyListener returned (stop, nil), so the caller logged "summon hotkey
// 'ctrl+space' registered" for a key that could never fire -- the one message
// guaranteed to send whoever is debugging a dead hotkey looking somewhere else.
//
// Ctrl+Space is genuinely contended on Windows (IMEs, launchers), and
// RegisterHotKey refuses a combination another hot key already holds, which is
// what this reproduces: hold one, then ask for it again.
func TestStartHotkeyListenerReportsARefusedRegistration(t *testing.T) {
	held, err := startHotkeyListener("ctrl+k", func() {})
	if err != nil {
		t.Skipf("this environment cannot register global hotkeys at all: %v", err)
	}
	defer held()

	second, err := startHotkeyListener("ctrl+k", func() {})
	if err == nil {
		// The OS allowed the duplicate, so there is no refusal to observe here.
		// Not a failure of the code under test -- release it and move on.
		if second != nil {
			second()
		}
		t.Skip("this Windows build allows a duplicate hot-key registration")
	}
	if second != nil {
		t.Fatal("a refused registration handed back a stop function; callers read a non-nil stop as a live hotkey")
	}
	if !strings.Contains(err.Error(), "ctrl+k") {
		t.Fatalf("the error should name the hotkey that failed, got: %v", err)
	}
}

// The errno is the only thing the OS tells us, and two of its values need
// translating before they reach a log a person has to act on.
func TestRegisterHotKeyErrorIsActionable(t *testing.T) {
	contended := registerHotKeyError("ctrl+space", errHotkeyAlreadyRegistered)
	if !strings.Contains(contended.Error(), "another application") {
		t.Fatalf("a contended combination should say who is holding it, got: %v", contended)
	}

	// A zero errno formats as "The operation completed successfully.", which as
	// the whole text of a failure message is worse than saying nothing.
	quiet := registerHotKeyError("ctrl+space", syscall.Errno(0))
	if strings.Contains(strings.ToLower(quiet.Error()), "completed successfully") {
		t.Fatalf("a zero errno must not be reported as success, got: %v", quiet)
	}

	other := registerHotKeyError("ctrl+space", syscall.Errno(87)) // ERROR_INVALID_PARAMETER
	if !strings.Contains(other.Error(), "ctrl+space") {
		t.Fatalf("the error should name the hotkey that failed, got: %v", other)
	}
}
