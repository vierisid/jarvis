package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
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
		fmt.Println(`jarvis-sidecar — Jarvis sidecar client (Go)

Usage:
  jarvis-sidecar --token <jwt>    Enroll and start (saves token to config)
  jarvis-sidecar                  Start using saved token
  jarvis-sidecar --test <cmd>     Run a built-in platform test (test build only)
  jarvis-sidecar --version        Print the sidecar version and exit
  jarvis-sidecar --help           Show this help`)
		os.Exit(0)
	}

	if *testMode {
		os.Exit(runTests(flag.Args()))
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

	if cfg.Token == "" {
		// Unconfigured: pop up the first-run window asking for the enrollment
		// token instead of erroring out. (--token still works headlessly.)
		log.Println("[sidecar] No token configured - opening setup window...")
		tok, err := runSetupWindow()
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

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("\n[sidecar] Shutting down...")
		client.Stop()
		cancel()
	}()

	client.Start(ctx)
}
