//go:build linux

package main

// TODO: Implement Linux tester.
//
// Should validate:
//   - X11/Wayland display connectivity
//   - Window enumeration (wmctrl / xdotool / swaymsg)
//   - Screen capture (scrot / grim / import)
//   - Clipboard access (xclip / xsel / wl-copy)
//   - Active window detection
//   - AT-SPI2 accessibility (if available)
//
// Reference: sidecar/desktop_linux.go, sidecar/platform_linux.go

func platformTests() []testCase {
	return []testCase{
		{"Linux/Placeholder", func(t *testCtx) {
			t.Logf("Linux tester not yet implemented")
		}},
	}
}
