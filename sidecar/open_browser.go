package main

// openInDefaultBrowser hands a URL to the OS default browser. The hosted
// first-run flow signs the user in there rather than in the embedded webview:
// the vendored engine has no window.open handling (Clerk's Google SSO popup
// silently no-ops) and Google rejects OAuth from embedded webviews anyway.

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"
)

func openInDefaultBrowser(ctx context.Context, url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open default browser: %w", err)
	}
	// A launcher normally hands off and exits immediately; a prompt nonzero
	// exit means no browser took the URL (xdg-open exits 3 when no handler is
	// configured). Wait only briefly — xdg-open's generic fallback can stay
	// alive as long as the browser it spawned, and that is a success — and
	// abandon the wait on ctx cancel so a closing window is never stalled
	// behind the verdict. The goroutine keeps waiting in those cases and
	// reaps the child — no zombies on any path.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		if err != nil {
			return fmt.Errorf("open default browser: %w", err)
		}
		return nil
	case <-time.After(3 * time.Second):
		return nil // still running: assume it is fronting the browser
	case <-ctx.Done():
		return ctx.Err()
	}
}
