//go:build darwin

package main

// TODO: Implement macOS tester.
//
// Should validate:
//   - Accessibility API access (AXUIElementCreateSystemWide, etc.)
//   - Window enumeration via CGWindowListCopyWindowInfo
//   - Screen capture via CGDisplayCreateImage
//   - Clipboard access via NSPasteboard
//   - Active window detection
//
// Reference: sidecar/desktop_darwin.go, sidecar/platform_darwin.go

func platformTests() []testCase {
	return []testCase{
		{"Darwin/Placeholder", func(t *testCtx) {
			t.Logf("macOS tester not yet implemented")
		}},
	}
}
