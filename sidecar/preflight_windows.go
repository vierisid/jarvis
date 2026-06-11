//go:build windows

package main

import (
	"fmt"
	"os/exec"
)

func checkTerminal(cfg *SidecarConfig) string {
	shell := cfg.Terminal.DefaultShell
	if shell == "" {
		shell = "cmd.exe"
	}
	if _, err := exec.LookPath(shell); err != nil {
		return fmt.Sprintf("shell %q not found", shell)
	}
	return ""
}

func checkClipboard() string {
	// PowerShell is built-in on Windows
	if _, err := exec.LookPath("powershell"); err != nil {
		return "powershell not found"
	}
	return ""
}

func checkScreenshot() string {
	// PowerShell with System.Windows.Forms is built-in
	if _, err := exec.LookPath("powershell"); err != nil {
		return "powershell not found"
	}
	return ""
}

func checkAwareness() string {
	// PowerShell Get-Process is built-in
	if _, err := exec.LookPath("powershell"); err != nil {
		return "powershell not found"
	}
	return ""
}

func checkBrowser(cfg *SidecarConfig) string {
	if _, err := findChromiumExecutable(cfg); err != nil {
		return err.Error()
	}
	return ""
}

func checkDesktop() string {
	// Windows always has a display server
	return ""
}
