package main

import "github.com/jarvis/sidecar/internal/psquote"

// The implementations live in internal/psquote so the installer, a separate
// main package, quotes PowerShell literals the same way.

// psSingleQuoted returns s as a PowerShell single-quoted literal, quotes included.
func psSingleQuoted(s string) string { return psquote.SingleQuoted(s) }

// psUTF8Base64Expr returns a PowerShell expression that evaluates to s.
func psUTF8Base64Expr(s string) string { return psquote.UTF8Base64Expr(s) }
