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
func TestHotkeysRefusedRegistrationIsReported(t *testing.T) {
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
func TestHotkeysRegisterErrorIsActionable(t *testing.T) {
	contended := registerHotKeyError("ctrl+space", errHotkeyAlreadyRegistered)
	if !strings.Contains(contended.Error(), "already held") {
		t.Fatalf("a contended combination should say the key is taken, got: %v", contended)
	}

	// A nil error is not reachable through LazyProc.Call (it always hands back
	// an Errno), but the formatting verb must not be the thing that finds out.
	if got := registerHotKeyError("ctrl+space", nil).Error(); strings.Contains(got, "%!w") {
		t.Fatalf("a nil errno should still format cleanly, got: %v", got)
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

// Every spelling below works on macOS and Linux, so it has to work here. The
// mixed-case one is the regression: "Ctrl+space" was rejected on Windows alone
// while the other two backends took it, and a rejected spec reaches the user as
// a hotkey that does nothing.
func TestHotkeysParseSpecMatchesTheOtherPlatforms(t *testing.T) {
	for _, c := range []struct {
		spec string
		mods uint32
		vk   uint32
	}{
		{"ctrl+space", modControl, 0x20},
		{"Ctrl+Space", modControl, 0x20},
		{"CTRL+SPACE", modControl, 0x20},
		{"Ctrl+space", modControl, 0x20}, // the spelling that used to fail
		{"  ctrl + space  ", modControl, 0x20},
		{"ctrl+spacebar", modControl, 0x20},
		{"ctrl+k", modControl, 0x4B},
		{"CTRL+K", modControl, 0x4B},
		{"ctrl+shift+k", modControl | modShift, 0x4B},
		{"control+alt+delete", modControl | modAlt, 0x2E},
		{"alt+f4", modAlt, 0x73},
		{"ctrl+f12", modControl, 0x7B},
		{"win+d", modWin, 0x44},
		{"super+1", modWin, 0x31},
		{"ctrl+option+up", modControl | modAlt, 0x26},
		{"f", 0, 0x46}, // a bare "f" is the letter, not a broken F-key
		{"f1", 0, 0x70},
		{"ctrl+enter", modControl, 0x0D},
		{"ctrl+esc", modControl, 0x1B},
	} {
		mods, vk, err := parseHotkey(c.spec)
		if err != nil {
			t.Errorf("parseHotkey(%q): unexpected error %v", c.spec, err)
			continue
		}
		if mods != c.mods || vk != c.vk {
			t.Errorf("parseHotkey(%q) = (0x%x, 0x%x), want (0x%x, 0x%x)", c.spec, mods, vk, c.mods, c.vk)
		}
	}
}

func TestHotkeysParseSpecRejectsWhatItCannotRegister(t *testing.T) {
	// Silently registering the wrong key would be worse than refusing: the
	// caller logs the refusal, and a wrong key looks like a broken one.
	for _, spec := range []string{
		"",
		"ctrl+",
		"hyper+k",       // modifier Win32 has no flag for
		"ctrl+capslock", // key we have no VK for
		"ctrl+f25",      // past VK_F24
		"ctrl+f0",
		"ctrl+space+k", // "space" read as a modifier
	} {
		if _, _, err := parseHotkey(spec); err == nil {
			t.Errorf("parseHotkey(%q) should have failed", spec)
		}
	}
}
