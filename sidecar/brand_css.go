package main

import "github.com/jarvis/sidecar/internal/brand"

// Shared Monochrome Lab styling for the sidecar's LOCAL pages — moved to
// internal/brand so the installer binary reuses the same tokens; these consts
// keep the sidecar's page builders unchanged. See internal/brand for the
// token/Pebble documentation.
const (
	brandTokensCSS = brand.TokensCSS
	brandPebbleCSS = brand.PebbleCSS

	// Custom window chrome (Windows): the title bar a page draws for itself
	// once winchrome.Install has removed the native one. Inert everywhere
	// else — see internal/brand/titlebar.go for the markup contract.
	brandTitlebarCSS  = brand.TitlebarCSS
	brandTitlebarHTML = brand.TitlebarHTML
	brandTitlebarJS   = brand.TitlebarJS

	// Keyboard scrolling for the pages whose scroll container is the inner
	// .pagebody wrapper the custom title bar requires. Not Windows-specific:
	// the wrapper is there on every platform.
	brandPageBodyJS = brand.PageBodyJS
)
