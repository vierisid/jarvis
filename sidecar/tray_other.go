//go:build !windows && !darwin

package main

import "context"

// No system tray on this platform (Linux/other) for now. Run the client on the
// main goroutine exactly as before.
func runWithTray(ctx context.Context, _ context.CancelFunc, client *SidecarClient) {
	client.Start(ctx)
}
