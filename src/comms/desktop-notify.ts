/**
 * Desktop Notification Sender
 *
 * Sends native desktop notifications.
 * Tries in order:
 *   1. notify-send (Linux/WSLg)
 *   2. PowerShell toast (WSL2 → Windows)
 * Gracefully degrades if neither is available.
 */

type NotifyMethod = 'notify-send' | 'powershell' | null;

let method: NotifyMethod | undefined;

function detectMethod(): NotifyMethod {
  if (method !== undefined) return method;

  // Try notify-send first (native Linux/WSLg)
  try {
    const result = Bun.spawnSync(['which', 'notify-send']);
    if (result.exitCode === 0) {
      method = 'notify-send';
      console.log('[DesktopNotify] Using notify-send');
      return method;
    }
  } catch { /* continue */ }

  // Try PowerShell (WSL2 → Windows toast)
  try {
    const result = Bun.spawnSync(['which', 'powershell.exe']);
    if (result.exitCode === 0) {
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

/** Wait for the native sender to report acceptance; spawning alone is not delivery. */
export async function sendDesktopNotificationWithReceipt(
  title: string, body: string,
  options?: { urgency?: 'low' | 'normal' | 'critical'; expireMs?: number },
): Promise<boolean> {
  const m = detectMethod();
  if (!m) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = m === 'notify-send' ? sendViaNotifySend(title, body, options) : sendViaPowerShell(title, body);
    return await Promise.race([
      child.exited.then(code => code === 0),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => {
          try { child.kill(); } catch { /* already exited */ }
          resolve(false);
        }, 5000);
      }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timeout); }
}

function sendViaNotifySend(
  title: string,
  body: string,
  options?: { urgency?: string; expireMs?: number }
): Bun.Subprocess<'ignore', 'ignore', 'ignore'> {
  return Bun.spawn(buildNotifySendArgs(title, body, options), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
}

/**
 * The title and body are argv, so no shell sees them, but notify-send parses
 * its argv with GLib: a title or body starting with `-` would be read as an
 * option (`-u x` fails the send, `-i` picks the icon file, `-w` blocks until
 * dismissed). `--` ends option parsing, so both are always positional. NUL is
 * dropped because Bun refuses to spawn with it, which would lose the send.
 */
export function buildNotifySendArgs(
  title: string,
  body: string,
  options?: { urgency?: string; expireMs?: number }
): string[] {
  const urgency = options?.urgency ?? 'normal';
  const expireMs = options?.expireMs ?? (urgency === 'critical' ? 10000 : 5000);

  return [
    'notify-send',
    `--urgency=${urgency}`,
    `--expire-time=${expireMs}`,
    '--app-name=JARVIS',
    '--',
    title.replaceAll('\0', ''),
    body.replaceAll('\0', ''),
  ];
}

function sendViaPowerShell(title: string, body: string): Bun.Subprocess<'ignore', 'ignore', 'ignore'> {
  return Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', buildPowerShellToastScript(title, body)], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
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
 * joins the stock ToastText02 template as a DOM text node, never parsed. Not
 * `$args` -- powershell.exe joins every argument after -Command into the
 * script -- nor stdin, which it reads in the OEM code page. The script has no
 * `"`, so no Windows command-line quoting layer can mangle it.
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
  const chars = Array.from(text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ''));
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/**
 * Check if desktop notifications are available.
 */
export function isDesktopNotifyAvailable(): boolean {
  return detectMethod() !== null;
}
