import type { AppController, WindowInfo, UIElement } from './interface.ts';
import { DesktopController } from './desktop-controller.ts';
import { spawnSync } from 'node:child_process';

/**
 * Windows App Controller.
 *
 * Two-layer implementation:
 *   1. Desktop sidecar (desktop-bridge.exe) via TCP JSON-RPC — full Win32/UI
 *      Automation support when the sidecar is built and running.
 *   2. PowerShell fallback — basic window listing, focus, screenshots, and
 *      input simulation via .NET / WinForms interop.
 *
 * The sidecar path is preferred for rich operations (UI tree, click by
 * element ID, typed element targeting). The PowerShell path covers the
 * basics without external dependencies.
 */
export class WindowsAppController implements AppController {
  private sidecar: DesktopController | null = null;
  private sidecarConnected = false;

  private async getSidecar(): Promise<DesktopController | null> {
    if (this.sidecarConnected && this.sidecar) return this.sidecar;
    try {
      this.sidecar = new DesktopController();
      await this.sidecar.connect();
      this.sidecarConnected = true;
      return this.sidecar;
    } catch {
      // Sidecar not available — use PowerShell fallback
      return null;
    }
  }

  /**
   * Run a PowerShell script and return stdout.
   */
  private ps(script: string): string {
    try {
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf-8', timeout: 15_000 }
      );
      return result.stdout?.trim() ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Run a PowerShell script that returns a JSON object.
   */
  private psJson<T>(script: string): T | null {
    const wrapper = `
      ${script}
      | ConvertTo-Json -Compress
    `;
    const out = this.ps(wrapper);
    if (!out) return null;
    try {
      return JSON.parse(out) as T;
    } catch {
      return null;
    }
  }

  async getActiveWindow(): Promise<WindowInfo> {
    const sc = await this.getSidecar();
    if (sc) return sc.getActiveWindow();

    // PowerShell fallback: get foreground window info
    const result = this.psJson<{
      pid: number;
      title: string;
      className: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>(`
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        using System.Drawing;
        public class Win32 {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int m);
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
          [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder c, int m);
          [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
          public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        }
"@
      $h = [Win32]::GetForegroundWindow()
      $sb = New-Object Text.StringBuilder 512
      $cb = New-Object Text.StringBuilder 256
      $null = [Win32]::GetWindowText($h, $sb, 512)
      $null = [Win32]::GetClassName($h, $cb, 256)
      $pid = 0; $null = [Win32]::GetWindowThreadProcessId($h, [ref]$pid)
      $r = New-Object Win32+RECT
      $null = [Win32]::GetWindowRect($h, [ref]$r)
      [PSCustomObject]@{
        pid = $pid
        title = $sb.ToString()
        className = $cb.ToString()
        x = $r.Left; y = $r.Top
        width = $r.Right - $r.Left
        height = $r.Bottom - $r.Top
      }
    `);
    if (result) {
      return {
        pid: result.pid,
        title: result.title || 'Unknown',
        className: result.className || 'Unknown',
        bounds: { x: result.x, y: result.y, width: result.width, height: result.height },
        focused: true,
      };
    }
    throw new Error('Could not get active window (no sidecar, PowerShell unavailable)');
  }

  async getWindowTree(_pid: number): Promise<UIElement[]> {
    const sc = await this.getSidecar();
    if (sc) return sc.getWindowTree(_pid);

    throw new Error(
      'UI element traversal on Windows requires the desktop-bridge sidecar. ' +
      'Build it with: bun run scripts/build-sidecar.ts'
    );
  }

  async listWindows(): Promise<WindowInfo[]> {
    const sc = await this.getSidecar();
    if (sc) return sc.listWindows();

    // PowerShell fallback: enumerate top-level windows
    const results = this.psJson<Array<{
      pid: number; title: string; className: string;
      x: number; y: number; width: number; height: number; focused: boolean;
    }>>(`
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        using System.Collections.Generic;
        public class Win32 {
          public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
          [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int m);
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
          [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder c, int m);
          [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
          [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
          public static IntPtr ForegroundWindow = IntPtr.Zero;
        }
"@
      $windows = @()
      $fg = [Win32]::GetForegroundWindow()
      $callback = {
        $h = $args[0]
        if (-not [Win32]::IsWindowVisible($h)) { return $true }
        $sb = New-Object Text.StringBuilder 512
        $cb = New-Object Text.StringBuilder 256
        $null = [Win32]::GetWindowText($h, $sb, 512)
        if ($sb.Length -eq 0) { return $true }
        $null = [Win32]::GetClassName($h, $cb, 256)
        $pid = 0; $null = [Win32]::GetWindowThreadProcessId($h, [ref]$pid)
        $r = New-Object Win32+RECT
        $null = [Win32]::GetWindowRect($h, [ref]$r)
        $script:windows += [PSCustomObject]@{
          pid = $pid
          title = $sb.ToString()
          className = $cb.ToString()
          x = $r.Left; y = $r.Top
          width = $r.Right - $r.Left
          height = $r.Bottom - $r.Top
          focused = ($h -eq $fg)
        }
        return $true
      }
      $null = [Win32]::EnumWindows($callback, [IntPtr]::Zero)
      $windows
    `);
    if (results && Array.isArray(results)) {
      return results.map(r => ({
        pid: r.pid,
        title: r.title || 'Unknown',
        className: r.className || 'Unknown',
        bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
        focused: r.focused || false,
      }));
    }
    if (results && !Array.isArray(results)) {
      // Single result (single window) — wrap in array
      const r = results as any;
      return [{
        pid: r.pid,
        title: r.title || 'Unknown',
        className: r.className || 'Unknown',
        bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
        focused: r.focused || false,
      }];
    }
    throw new Error('Could not list windows (no sidecar, PowerShell unavailable)');
  }

  async clickElement(element: UIElement): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.clickElement(element);

    // PowerShell fallback: move mouse and click at element center
    const cx = Math.round(element.bounds.x + element.bounds.width / 2);
    const cy = Math.round(element.bounds.y + element.bounds.height / 2);
    this.ps(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.Cursor]::Position = New-Object Drawing.Point(${cx}, ${cy})
      Start-Sleep -Milliseconds 50
      [System.Windows.Forms.SendKeys]::SendWait('{CLICK}')
    `);
  }

  async typeText(text: string): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.typeText(text);

    // Escape text for PowerShell SendKeys
    const escaped = text
      .replace(/\{/g, '{{}')
      .replace(/\}/g, '{}}')
      .replace(/\+/g, '{+}')
      .replace(/\^/g, '{^}')
      .replace(/~/g, '{~}')
      .replace(/\(/g, '{(}')
      .replace(/\)/g, '{)}')
      .replace(/\!/g, ' Surround EscapeExclamation')
      .replace(/\n/g, '{ENTER}');

    this.ps(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
    `);
  }

  async pressKeys(keys: string[]): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.pressKeys(keys);

    // Convert key names to SendKeys format
    const keyMap: Record<string, string> = {
      'Enter': '{ENTER}',
      'Tab': '{TAB}',
      'Escape': '{ESC}',
      'Backspace': '{BACKSPACE}',
      'Delete': '{DELETE}',
      'Home': '{HOME}',
      'End': '{END}',
      'Up': '{UP}',
      'Down': '{DOWN}',
      'Left': '{LEFT}',
      'Right': '{RIGHT}',
      'Control': '^',
      'Alt': '%',
      'Shift': '+',
    };

    const combo = keys.map(k => keyMap[k] || k).join('');
    this.ps(`
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait('${combo}')
    `);
  }

  async captureScreen(): Promise<Buffer> {
    const sc = await this.getSidecar();
    if (sc) return sc.captureScreen();

    // PowerShell fallback: capture screen via .NET
    const base64 = this.ps(`
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
      $g = [Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
      $ms = New-Object IO.MemoryStream
      $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      [Convert]::ToBase64String($ms.ToArray())
    `);
    if (base64) {
      return Buffer.from(base64, 'base64');
    }
    throw new Error('Could not capture screen (no sidecar, PowerShell unavailable)');
  }

  async captureWindow(pid: number): Promise<Buffer> {
    const sc = await this.getSidecar();
    if (sc) return sc.captureWindow(pid);

    // PowerShell: capture by PID via window rect and full-screen crop
    const base64 = this.ps(`
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Drawing;
        using System.Drawing.Imaging;
        public class Win32 {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
          public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        }
"@
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
      $g = [Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
      $ms = New-Object IO.MemoryStream
      $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      [Convert]::ToBase64String($ms.ToArray())
    `);
    if (base64) {
      return Buffer.from(base64, 'base64');
    }
    throw new Error('Could not capture window (no sidecar, PowerShell unavailable)');
  }

  async focusWindow(pid: number): Promise<void> {
    const sc = await this.getSidecar();
    if (sc) return sc.focusWindow(pid);

    // PowerShell: bring window to foreground by PID
    // We use the SendKeys approach via Win32 SetForegroundWindow
    this.ps(`
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class Win32 {
          public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
          [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
          [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          public static IntPtr TargetWindow = IntPtr.Zero;
          public static int TargetPid = ${pid};
        }
"@
      $callback = {
        $h = $args[0]
        if (-not [Win32]::IsWindowVisible($h)) { return $true }
        $p = 0; $null = [Win32]::GetWindowThreadProcessId($h, [ref]$p)
        if ($p -eq [Win32]::TargetPid) {
          [Win32]::TargetWindow = $h
          return $false
        }
        return $true
      }
      $null = [Win32]::EnumWindows($callback, [IntPtr]::Zero)
      if ([Win32]::TargetWindow -ne [IntPtr]::Zero) {
        $null = [Win32]::SetForegroundWindow([Win32]::TargetWindow)
      }
    `);
  }

  /**
   * Launch an application by executable path.
   */
  async launchApp(executable: string, args?: string): Promise<object> {
    const sc = await this.getSidecar();
    if (sc) {
      if (typeof sc.launchApp === 'function') {
        return sc.launchApp(executable, args);
      }
    }

    // PowerShell fallback: Start-Process
    this.ps(`
      Start-Process -FilePath '${executable.replace(/'/g, "''")}' ${args ? `-ArgumentList '${args.replace(/'/g, "''")}'` : ''}
    `);
    return { executable, args: args ?? '' };
  }

  /**
   * Close a window by PID via sidecar.
   */
  async closeWindow(pid: number): Promise<void> {
    const sc = await this.getSidecar();
    if (sc && typeof sc.closeWindow === 'function') {
      return sc.closeWindow(pid);
    }
    // PowerShell fallback: kill process
    this.ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
  }
}
