<#
  Jarvis desktop helper — Windows fallback path (no sidecar).

  Invoked as:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File desktop.ps1 <command>

  The JSON payload (if any) arrives on stdin — never interpolated into script
  text, so arbitrary user/LLM-derived strings cannot alter the script.
  Results are written to stdout (JSON or base64); any failure writes a message
  to stderr and exits non-zero.

  Must stay PowerShell 5.1 compatible: no ternary, no null-coalescing, no
  pipeline continuation at start-of-line.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command
)

$ErrorActionPreference = 'Stop'

# Redirected stdout/stderr default to the OEM code page on Windows PowerShell;
# emit UTF-8 so non-ASCII window titles survive the trip back to Node. The
# inbound payload is ASCII-safe JSON (see toAsciiJson in windows.ts), so the
# stdin encoding does not matter.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisWin32 {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmdShow);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint WM_CLOSE = 0x0010;
    const int SW_RESTORE = 9;

    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    // Fields: pid, focused, x, y, width, height, className, title.
    // Tab-separated; title comes last and has tabs/newlines squashed.
    static string Describe(IntPtr hWnd, IntPtr foreground) {
        StringBuilder title = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        StringBuilder cls = new StringBuilder(256);
        GetClassName(hWnd, cls, cls.Capacity);
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        RECT r;
        GetWindowRect(hWnd, out r);
        string safeClass = cls.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
        string safeTitle = title.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
        return string.Join("\t", new string[] {
            processId.ToString(),
            hWnd == foreground ? "1" : "0",
            r.Left.ToString(), r.Top.ToString(),
            (r.Right - r.Left).ToString(), (r.Bottom - r.Top).ToString(),
            safeClass, safeTitle
        });
    }

    public static string ActiveWindow() {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) throw new InvalidOperationException("No foreground window");
        return Describe(fg, fg);
    }

    public static string[] ListWindows() {
        IntPtr fg = GetForegroundWindow();
        List<string> lines = new List<string>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder title = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            if (title.Length == 0) return true;
            lines.Add(Describe(hWnd, fg));
            return true;
        }, IntPtr.Zero);
        return lines.ToArray();
    }

    static IntPtr FindMainWindow(int processId) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            uint winPid;
            GetWindowThreadProcessId(hWnd, out winPid);
            if (winPid == (uint)processId) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static int[] WindowRect(int processId) {
        IntPtr hWnd = FindMainWindow(processId);
        if (hWnd == IntPtr.Zero) throw new InvalidOperationException("No visible window for PID " + processId);
        RECT r;
        GetWindowRect(hWnd, out r);
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static void Focus(int processId) {
        IntPtr hWnd = FindMainWindow(processId);
        if (hWnd == IntPtr.Zero) throw new InvalidOperationException("No visible window for PID " + processId);
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
        if (SetForegroundWindow(hWnd)) return;
        // Foreground lock: attach to the current foreground thread and retry.
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
        uint self = GetCurrentThreadId();
        AttachThreadInput(self, fgThread, true);
        bool ok = SetForegroundWindow(hWnd);
        AttachThreadInput(self, fgThread, false);
        if (!ok) throw new InvalidOperationException("Could not bring window to foreground for PID " + processId);
    }

    public static void Close(int processId) {
        IntPtr hWnd = FindMainWindow(processId);
        if (hWnd == IntPtr.Zero) throw new InvalidOperationException("No visible window for PID " + processId);
        if (!PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) {
            throw new InvalidOperationException("PostMessage(WM_CLOSE) failed for PID " + processId);
        }
    }

    public static void ClickAt(int x, int y) {
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos(" + x + ", " + y + ") failed");
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }

    // Without this, powershell.exe is DPI-virtualized on scaled displays:
    // window rects, cursor coordinates, and captures come back in scaled
    // (non-native) pixels.
    public static void MakeDpiAware() {
        SetProcessDPIAware();
    }
}
"@

# Best-effort: SetProcessDPIAware never throws on Windows; the catch only
# fires where user32 is absent (the linux-CI pwsh syntax probe).
try { [JarvisWin32]::MakeDpiAware() } catch { }

function Read-Payload {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return ConvertFrom-Json -InputObject $raw
}

function ConvertFrom-WindowLine {
  param([string]$Line)
  $parts = $Line -split "`t", 8
  return [PSCustomObject]@{
    pid = [int]$parts[0]
    focused = ($parts[1] -eq '1')
    x = [int]$parts[2]
    y = [int]$parts[3]
    width = [int]$parts[4]
    height = [int]$parts[5]
    className = $parts[6]
    title = $parts[7]
  }
}

function Get-RectCaptureBase64 {
  param([int]$X, [int]$Y, [int]$Width, [int]$Height)
  if ($Width -le 0 -or $Height -le 0) { throw "Invalid capture region ${Width}x${Height}" }
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $ms = $null
  try {
    $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($Width, $Height)))
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return [Convert]::ToBase64String($ms.ToArray())
  } finally {
    if ($null -ne $ms) { $ms.Dispose() }
    $g.Dispose()
    $bmp.Dispose()
  }
}

try {
  switch ($Command) {
    'get-active-window' {
      $win = ConvertFrom-WindowLine -Line ([JarvisWin32]::ActiveWindow())
      Write-Output (ConvertTo-Json -InputObject $win -Compress)
    }
    'list-windows' {
      $wins = @([JarvisWin32]::ListWindows() | ForEach-Object { ConvertFrom-WindowLine -Line $_ })
      Write-Output (ConvertTo-Json -InputObject $wins -Compress)
    }
    'click-at' {
      $p = Read-Payload
      [JarvisWin32]::ClickAt([int]$p.x, [int]$p.y)
    }
    'send-keys' {
      # The SendKeys string is pre-escaped by the caller (see windows.ts).
      $p = Read-Payload
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait([string]$p.keys)
    }
    'capture-screen' {
      Add-Type -AssemblyName System.Windows.Forms
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      Write-Output (Get-RectCaptureBase64 -X $b.X -Y $b.Y -Width $b.Width -Height $b.Height)
    }
    'capture-window' {
      $p = Read-Payload
      $r = [JarvisWin32]::WindowRect([int]$p.pid)
      Write-Output (Get-RectCaptureBase64 -X $r[0] -Y $r[1] -Width $r[2] -Height $r[3])
    }
    'focus-window' {
      $p = Read-Payload
      [JarvisWin32]::Focus([int]$p.pid)
    }
    'close-window' {
      $p = Read-Payload
      [JarvisWin32]::Close([int]$p.pid)
    }
    'launch-app' {
      $p = Read-Payload
      if ([string]::IsNullOrWhiteSpace([string]$p.args)) {
        $proc = Start-Process -FilePath ([string]$p.executable) -PassThru
      } else {
        $proc = Start-Process -FilePath ([string]$p.executable) -ArgumentList ([string]$p.args) -PassThru
      }
      # -PassThru returns nothing when the shell reuses an existing process
      # (documents, URLs) — report pid null rather than failing the launch.
      $launchedPid = $null
      if ($null -ne $proc) { $launchedPid = $proc.Id }
      Write-Output (ConvertTo-Json -InputObject @{ pid = $launchedPid } -Compress)
    }
    default {
      throw "Unknown command: $Command"
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
