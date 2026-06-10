//go:build !windows && !darwin

package main

import "context"

// No system tray on this platform (Linux/other) for now. Run the client on the
// main goroutine exactly as before.
func runWithTray(ctx context.Context, cancel context.CancelFunc, client *SidecarClient) {
	// No tray here, but wire shutdown so an in-app restart can exit the process.
	client.SetShutdown(func() {
		client.Stop()
		cancel()
	})
	client.Start(ctx)
}
