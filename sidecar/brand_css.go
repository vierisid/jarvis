package main

import "github.com/jarvis/sidecar/internal/brand"

// Shared Monochrome Lab styling for the sidecar's LOCAL pages — moved to
// internal/brand so the installer binary reuses the same tokens; these consts
// keep the sidecar's page builders unchanged. See internal/brand for the
// token/Pebble documentation.
const (
	brandTokensCSS = brand.TokensCSS
	brandPebbleCSS = brand.PebbleCSS
)
