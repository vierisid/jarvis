package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// A notification button was clicked: the OS launched us with a jarvis:// URI.
	// Forward the action to the already-running sidecar and exit before any heavy
	// init (so we never boot a second instance that would grab the mic / tray).
	if maybeForwardProtocolLaunch() {
		return
	}

	token := flag.String("token", "", "JWT enrollment token from the brain")
	help := flag.Bool("help", false, "Show help")
	showVersion := flag.Bool("version", false, "Print the sidecar version and exit")
	testMode := flag.Bool("test", false, "Run built-in platform tests (requires build with -tags sidecartest)")
	flag.Parse()

	if *showVersion {
		fmt.Println(sidecarVersion)
		os.Exit(0)
	}

	if *help {
		fmt.Println(`jarvis — Jarvis sidecar client (Go)

Usage:
  jarvis --token <jwt>    Enroll and start (saves token to config)
  jarvis                  Start using saved token
  jarvis --test <cmd>     Run a built-in platform test (test build only)
  jarvis --version        Print the sidecar version and exit
  jarvis --help           Show this help`)
		os.Exit(0)
	}

	if *testMode {
		os.Exit(runTests(flag.Args()))
	}

	// Route logs to ~/.jarvis/sidecar.log so the GUI-subsystem Windows build runs
	// without a console window (and so there's a log to inspect anywhere).
	setupLogging()

	// Register the AUMID + jarvis:// URI scheme notifications need (Windows-only;
	// no-op elsewhere). Idempotent, cheap, safe to run every launch.
	setupNotifications()

	// When relaunched by an in-app restart (settings token change), wait briefly
	// for the previous instance to exit and release the mic / hotkeys / tray icon
	// before we grab them.
	if os.Getenv("JARVIS_RELAUNCH") == "1" {
		log.Println("[sidecar] relaunched — waiting for the previous instance to exit...")
		time.Sleep(restartRelaunchWait)
	}

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("[sidecar] Failed to load config: %v", err)
	}

	if *token != "" {
		cfg.Token = *token
		if err := SaveConfig(cfg); err != nil {
			log.Fatalf("[sidecar] Failed to save config: %v", err)
		}
		log.Println("[sidecar] Token saved to config")
	}

	// Reconcile OS autostart with the saved preference: re-register with the
	// current executable path so a moved/renamed binary fixes its login entry on
	// the next launch (idempotent when the path is unchanged).
	if cfg.Preferences.StartAtStartup {
		if err := platformSetAutoStart(true); err != nil {
			log.Printf("[sidecar] could not refresh start-at-startup registration: %v", err)
		}
	}

	// On Windows the dashboard panels AND the first-run setup window are
	// WebView2-backed (no-op check on Linux/macOS). ensureWebView2Runtime blocks
	// through any user-triggered install and only returns false if the runtime
	// is still absent (declined / timed out), in which case we can't render any
	// window, so exit cleanly.
	if !ensureWebView2Runtime() {
		log.Println("[sidecar] WebView2 runtime not installed — JARVIS can't show its windows. Exiting.")
		os.Exit(0)
	}

	if cfg.Token == "" {
		// Unconfigured: pop up the first-run window asking for the enrollment
		// token instead of erroring out. (--token still works headlessly.)
		log.Println("[sidecar] No token configured - opening connect window...")
		tok, err := runFirstRunWindow(cfg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\nAlternatively, run: jarvis-sidecar --token <jwt>\n", err)
			os.Exit(1)
		}
		if tok == "" {
			fmt.Fprintln(os.Stderr, "Setup cancelled - no token entered.")
			os.Exit(1)
		}
		cfg.Token = tok
		if err := SaveConfig(cfg); err != nil {
			log.Fatalf("[sidecar] Failed to save config: %v", err)
		}
		log.Println("[sidecar] Token saved to config")
		// Re-exec into a clean process so the overlays don't share a process with
		// the setup window's webview (GTK main-loop conflict on Linux). On Unix
		// this does not return; on Windows it's a no-op and we continue.
		restartAfterSetup()
	}

	client, err := NewSidecarClient(cfg)
	if err != nil {
		log.Fatalf("[sidecar] Failed to create client: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Anonymous usage telemetry (opt-out). Runs regardless of brain connection
	// so we can also see sidecars that start but never connect. Fire-and-forget;
	// it can never block or crash startup. Stops when ctx is cancelled.
	StartTelemetry(ctx, client)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("\n[sidecar] Shutting down...")
		// The browser runs in its own process group (Setpgid), so terminal
		// signals no longer reach it — close it explicitly or it outlives us.
		closeActiveCDP()
		client.Stop()
		cancel()
	}()

	// runWithTray runs the client plus, on Windows/macOS, a system-tray /
	// menu-bar icon whose "Close" entry stops the sidecar. It owns the per-OS
	// threading (the macOS menu-bar item needs the main thread + NSApp run loop)
	// and blocks until the client stops. Linux/other have no tray and just run
	// the client.
	runWithTray(ctx, cancel, client)
}
