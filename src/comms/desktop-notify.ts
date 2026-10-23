/**
 * Desktop Notification Sender
 *
 * Sends native desktop notifications.
 * Tries in order:
 *   1. notify-send (Linux/WSLg)
 *   2. PowerShell toast (WSL2 → Windows)
 * Gracefully degrades if neither is available.
 */

import { modelExecEnv } from '../util/model-exec-env.ts';
import { WSLBridge, windowsSystemExe } from '../actions/terminal/wsl-bridge.ts';
import { findLinuxSystemExe, linuxSystemExe } from '../util/system-exe.ts';

type NotifyMethod = 'notify-send' | 'powershell' | null;

let method: NotifyMethod | undefined;

function detectMethod(): NotifyMethod {
  if (method !== undefined) return method;

  // Try notify-send first (native Linux/WSLg): from a system directory only,
  // looked up without spawning anything. It was `which notify-send` and then
  // a bare `notify-send`, so the first one on PATH ran -- and a stock PATH
  // puts ~/.local/bin and ~/.bun/bin ahead of /usr/bin (#900).
  const notifySend = findLinuxSystemExe('notify-send');
  if (notifySend.path !== null) {
    method = 'notify-send';
    console.log('[DesktopNotify] Using notify-send');
    return method;
  }
  if (notifySend.rejected.length) {
    console.log(`[DesktopNotify] notify-send not used: ${notifySend.rejected.join('; ')}`);
  }

  // Try PowerShell (WSL2 → Windows toast): the System32 one, under WSL only.
  // It used to be `which powershell.exe`, then a bare `powershell.exe`, so
  // whichever came first on PATH ran -- and WSL's PATH puts the user's own
  // bin dirs and third-party Windows dirs ahead of System32 (#896).
  try {
    if (WSLBridge.isWSL()) {
      windowsSystemExe('powershell.exe');
      method = 'powershell';
      console.log('[DesktopNotify] Using PowerShell toasts');
      return method;
    }
  } catch { /* continue */ }

  method = null;
  console.log('[DesktopNotify] No notification method available');
  return method;
}

/**
 * Send a native desktop notification.
 * Returns true if a sender was launched, false if unavailable.
 */
export function sendDesktopNotification(
  title: string,
  body: string,
  options?: {
    urgency?: 'low' | 'normal' | 'critical';
    expireMs?: number;
  }
): boolean {
  const m = detectMethod();
  if (!m) return false;

  try {
    if (m === 'notify-send') {
      sendViaNotifySend(title, body, options);
    } else {
      sendViaPowerShell(title, body);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * What became of a desktop notification (Q-19): `shown` when the native sender
 * exited cleanly, `not_shown` when there is no sender or it failed, `unknown`
 * when it ran past the wait and was stopped, by which time the toast may
 * already be on screen (a cold PowerShell launch under WSL2 can take that long).
 */
export type DesktopReceipt = 'shown' | 'not_shown' | 'unknown';

export async function sendDesktopNotificationReceipt(
  title: string, body: string,
  options?: { urgency?: 'low' | 'normal' | 'critical'; expireMs?: number },
): Promise<DesktopReceipt> {
  const m = detectMethod();
  if (!m) return 'not_shown';
  try {
    const child = m === 'notify-send' ? sendViaNotifySend(title, body, options) : sendViaPowerShell(title, body);
    return await senderReceipt(child.exited, () => child.kill());
  } catch { return 'not_shown'; }
}

/** A native sender's receipt: its exit, or `unknown` once it runs past the wait and is stopped. */
export async function senderReceipt(exited: Promise<number>, kill: () => void, waitMs = 5000): Promise<DesktopReceipt> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then((code): DesktopReceipt => code === 0 ? 'shown' : 'not_shown'),
      new Promise<DesktopReceipt>(resolve => {
        timeout = setTimeout(() => {
          try { kill(); } catch { /* already exited */ }
          resolve('unknown');
        }, waitMs);
      }),
    ]);
  } finally { clearTimeout(timeout); }
}

/** Wait for the native sender to report acceptance; spawning alone is not delivery. */
export async function sendDesktopNotificationWithReceipt(
  title: string, body: string,
  options?: { urgency?: 'low' | 'normal' | 'critical'; expireMs?: number },
): Promise<boolean> {
  return (await sendDesktopNotificationReceipt(title, body, options)) === 'shown';
}

function sendViaNotifySend(
  title: string,
  body: string,
  options?: { urgency?: string; expireMs?: number }
): Bun.Subprocess<'ignore', 'ignore', 'ignore'> {
  return Bun.spawn([linuxSystemExe('notify-send'), ...buildNotifySendArgs(title, body, options)], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
}

/**
 * notify-send's arguments; the program itself is resolved at the spawn
 * (#900). The title and body are argv, so no shell sees them, but libnotify's
 * notify-send parses its argv with GLib: a title or body starting with `-`
 * would be read as an option (`-u x` fails the send, `-i` picks the icon file,
 * `-w` blocks until dismissed). `--` ends option parsing, so both are always
 * positional. NUL is dropped because Bun refuses to spawn with it, which would
 * lose the send.
 */
export function buildNotifySendArgs(
  title: string,
  body: string,
  options?: { urgency?: string; expireMs?: number }
): string[] {
  const urgency = options?.urgency ?? 'normal';
  const expireMs = options?.expireMs ?? (urgency === 'critical' ? 10000 : 5000);

  return [
    `--urgency=${urgency}`,
    `--expire-time=${expireMs}`,
    '--app-name=JARVIS',
    '--',
    title.replaceAll('\0', ''),
    body.replaceAll('\0', ''),
  ];
}

function sendViaPowerShell(title: string, body: string): Bun.Subprocess<'ignore', 'ignore', 'ignore'> {
  return Bun.spawn([windowsSystemExe('powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', buildPowerShellToastScript(title, body)], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    // An interpreter run for model- or workflow-authored text. Since #515 that
    // text arrives only as base64 decoded into toast text nodes, never as
    // script; independently of that, the interpreter gets the desktop session
    // without the daemon's secrets (#514; see util/model-exec-env.ts).
    env: modelExecEnv(),
  });
}

/** Longest title and body the toast shows, in code points. */
export const TOAST_TITLE_MAX = 100;
export const TOAST_BODY_MAX = 200;

/**
 * The `-Command` script for a Windows toast. The title and body can be
 * workflow- or model-authored and are never PowerShell or XML source (#515):
 * each travels as base64 of its UTF-8, which cannot end the single-quoted
 * literal it sits in (PowerShell also closes one on U+2018..U+201B), and
 * joins the stock ToastText02 template as a DOM text node, never parsed.
 * Inline, not in `$args`: with `-Command` and no script file, powershell.exe
 * joins every argument after -Command into the script itself. Nor on stdin:
 * the script would have to read it, and 5.1 decodes redirected stdin in the
 * OEM code page (the `-File` helper in actions/app-control/windows.ts pays for
 * that with toAsciiJson). The script has no `"`, so no Windows command-line
 * quoting layer can mangle it.
 */
export function buildPowerShellToastScript(title: string, body: string): string {
  const encode = (text: string, max: number) => Buffer.from(clampToastText(text, max), 'utf8').toString('base64');

  return `
    $ErrorActionPreference = 'Stop'
    $title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(title, TOAST_TITLE_MAX)}'))
    $body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(body, TOAST_BODY_MAX)}'))
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $text = $xml.GetElementsByTagName('text')
    $text.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null
    $text.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('JARVIS').Show($toast)
  `.trim();
}

/**
 * Drop what XML 1.0 cannot carry, then cut to `max` code points of the raw
 * text: before any encoding, and never leaving a lone surrogate.
 */
function clampToastText(text: string, max: number): string {
  let out = '';
  let count = 0;
  for (const ch of text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')) {
    if (count++ === max) break;
    out += ch;
  }
  return out;
}

/**
 * Check if desktop notifications are available.
 */
export function isDesktopNotifyAvailable(): boolean {
  return detectMethod() !== null;
}
