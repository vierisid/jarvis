//go:build windows

package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
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
	return exec.CommandContext(ctx, "powershell", "-command", psScript).Run()
}

func platformDefaultShell() string {
	return "cmd.exe"
}

func platformGetActiveWindow() (appName string, windowTitle string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Get foreground window's process name and title using Win32 API via PowerShell
	out, err := exec.CommandContext(ctx, "powershell.exe", "-command",
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
[FG]::Get()`).Output()
	if err != nil {
		return "", ""
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "|", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", strings.TrimSpace(string(out))
}
