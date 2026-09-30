//go:build !windows

package update

// RefreshRegistration is Windows-only: no other platform keeps a system
// record of the installed version (macOS reads Info.plist, which the swap
// replaced along with the bundle).
func RefreshRegistration(string, string) error { return nil }
