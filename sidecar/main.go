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
	testMode := flag.Bool("test", false, "Run built-in platform tests (requires build with -tags sidecartest)")
	flag.Parse()

	if *help {
		fmt.Println(`jarvis-sidecar — Jarvis sidecar client (Go)

Usage:
  jarvis-sidecar --token <jwt>    Enroll and start (saves token to config)
  jarvis-sidecar                  Start using saved token
  jarvis-sidecar --test <cmd>     Run a built-in platform test (test build only)
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
		fmt.Fprintln(os.Stderr, "Error: No token configured. Run with --token <jwt> first.")
		os.Exit(1)
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
