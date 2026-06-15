//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

func platformClipboardRead() (string, error) {
	return runCmd("powershell", []string{"-command", "Get-Clipboard"}, "")
}

func platformClipboardWrite(content string) error {
	escaped := strings.ReplaceAll(content, "'", "''")
	_, err := runCmd("powershell", []string{"-command", fmt.Sprintf("Set-Clipboard -Value '%s'", escaped)}, "")
	return err
}

func platformCaptureScreen(outputPath string) error {
	psScript := fmt.Sprintf(
		`Add-Type -AssemblyName System.Windows.Forms; `+
			`[System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { `+
			`$bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); `+
			`$g = [System.Drawing.Graphics]::FromImage($bmp); `+
			`$g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); `+
			`$bmp.Save('%s') }`, outputPath)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell", "-command", psScript)
	hideSubprocessWindow(cmd)
	return cmd.Run()
}

func platformDefaultShell() string {
	return "cmd.exe"
}

// findChromiumExecutable locates a Chromium-based browser to drive: the
// configured override, else the OS default browser if it is Chromium-based,
// else the first known install (Chrome, Edge -- always present on Win10/11 --
// Brave, ...).
func findChromiumExecutable(cfg *SidecarConfig) (string, error) {
	if p := cfg.Browser.ExecutablePath; p != "" {
		if r := resolveConfiguredBrowser(p); r != "" {
			return r, nil
		}
		return "", fmt.Errorf("configured browser executable not found: %s", p)
	}

	var candidates []string
	if def := windowsDefaultBrowserExe(); def != "" {
		candidates = append(candidates, def)
	}
	candidates = append(candidates, windowsChromiumCandidates()...)
	for _, c := range candidates {
		if isExecutableFile(c) {
			return c, nil
		}
	}
	return "", fmt.Errorf("no Chromium-based browser found (install Chrome, Edge or Brave)")
}

func isExecutableFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// resolveConfiguredBrowser turns a configured executable_path into a usable
// path. It accepts a full/relative path that exists, or a bare exe name
// (e.g. "msedge.exe") which it resolves via PATH and then the known install
// locations. Returns "" if nothing matches.
func resolveConfiguredBrowser(p string) string {
	if isExecutableFile(p) {
		return p
	}
	if filepath.Base(p) == p { // bare name
		if lp, err := exec.LookPath(p); err == nil {
			return lp
		}
		want := strings.ToLower(p)
		for _, c := range windowsChromiumCandidates() {
			if strings.ToLower(filepath.Base(c)) == want && isExecutableFile(c) {
				return c
			}
		}
	}
	return ""
}

// windowsChromiumCandidates lists known install locations across the per-machine
// and per-user program directories.
func windowsChromiumCandidates() []string {
	rel := []string{
		`Google\Chrome\Application\chrome.exe`,
		`Microsoft\Edge\Application\msedge.exe`,
		`BraveSoftware\Brave-Browser\Application\brave.exe`,
		`Vivaldi\Application\vivaldi.exe`,
		`Chromium\Application\chrome.exe`,
	}
	var out []string
	for _, base := range []string{
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("LocalAppData"),
	} {
		if base == "" {
			continue
		}
		for _, r := range rel {
			out = append(out, filepath.Join(base, r))
		}
	}
	return out
}

// windowsDefaultBrowserExe resolves the user's default https handler to an
// executable path, returning it only if it is a recognised Chromium browser.
func windowsDefaultBrowserExe() string {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`,
		registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	progID, _, err := k.GetStringValue("ProgId")
	if err != nil || progID == "" {
		return ""
	}

	cmdKey, err := registry.OpenKey(registry.CLASSES_ROOT, progID+`\shell\open\command`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer cmdKey.Close()
	cmd, _, err := cmdKey.GetStringValue("")
	if err != nil || cmd == "" {
		return ""
	}

	exe := exeFromShellCommand(cmd)
	switch strings.ToLower(filepath.Base(exe)) {
	case "chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe", "chromium.exe":
		return exe
	}
	return ""
}

// exeFromShellCommand pulls the executable path out of a registry shell\open
// command string such as `"C:\...\chrome.exe" -- "%1"`.
func exeFromShellCommand(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	if strings.HasPrefix(cmd, `"`) {
		if end := strings.IndexByte(cmd[1:], '"'); end >= 0 {
			return cmd[1 : 1+end]
		}
		return ""
	}
	if sp := strings.IndexByte(cmd, ' '); sp >= 0 {
		return cmd[:sp]
	}
	return cmd
}

func platformGetActiveWindow() (appName string, windowTitle string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Get foreground window's process name and title using Win32 API via PowerShell
	cmd := exec.CommandContext(ctx, "powershell.exe", "-command",
		`Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int count);
  public static string Get() {
    var h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "|";
    uint pid; GetWindowThreadProcessId(h, out pid);
    var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
    try { var p = Process.GetProcessById((int)pid); return p.ProcessName + "|" + sb.ToString(); }
    catch { return "|" + sb.ToString(); }
  }
}
'@
[FG]::Get()`)
	hideSubprocessWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", ""
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "|", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", strings.TrimSpace(string(out))
}
