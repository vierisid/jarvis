/**
 * The two desktop reads the pebble voice loop makes on its own, without a tool
 * call: the foreground window on every cycle, and a screenshot when the spoken
 * request is spatial ("where is X?"). Moved out of daemon/index.ts so the
 * desktop.enabled switch (#905) can be tested on them: with it off, neither
 * dispatches anything and both report "nothing", which every caller already
 * handles as a failed best-effort read.
 */

import { isDesktopEnabled } from '../actions/tools/desktop-guard.ts';

/** `SidecarManager.dispatchRPC`, narrowed to what these reads use. */
export type PebbleDesktopDispatch = (sidecarId: string, method: string, params: Record<string, unknown>) => Promise<unknown>;

export type ScreenshotInfo = {
  base64: string;
  mediaType: string;
  // Scale factors: capture-native pixels per sent-image pixel. The
  // model picks coordinates in the (downscaled) image; we multiply by
  // these before dispatching pebble.point_at. =1 when the image was not
  // resized.
  //
  // CAPTURE-NATIVE, not "real-screen" (#604): orig_* is the pixel size
  // of whatever `platformCaptureScreen` wrote, read off that image's own
  // header, so it is backing pixels on a Retina Mac and primary-monitor
  // pixels on Windows. That is not the space the pebble eases in. The
  // multiply site has the per-platform detail and the reason no
  // conversion is applied.
  scaleX: number;
  scaleY: number;
  origWidth: number;
  origHeight: number;
  sentWidth: number;
  sentHeight: number;
};

export async function fetchPebbleScreenshot(dispatch: PebbleDesktopDispatch, sidecarId: string): Promise<ScreenshotInfo | null> {
  if (!isDesktopEnabled()) return null;
  try {
    const result = await Promise.race<unknown>([
      // compact: true -> sidecar downscales to <=1600 wide and
      // re-encodes as JPEG (q=80). Keeps the round-trip well under
      // the 16 MB WS limit and within vision-LLM-friendly sizes
      // while still resolving button text legibly.
      dispatch(sidecarId, 'capture_screen', { compact: true, max_width: 1600, jpeg_quality: 80 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    const obj = result as Record<string, unknown> | undefined;
    const binary = obj?._binary as { data?: string; mime_type?: string } | undefined;
    if (!binary?.data) return null;
    const sentWidth = Number(obj?.width ?? 0) || 0;
    const sentHeight = Number(obj?.height ?? 0) || 0;
    const origWidth = Number(obj?.orig_width ?? 0) || sentWidth;
    const origHeight = Number(obj?.orig_height ?? 0) || sentHeight;
    const scaleX = sentWidth > 0 ? origWidth / sentWidth : 1;
    const scaleY = sentHeight > 0 ? origHeight / sentHeight : 1;
    return {
      base64: binary.data,
      mediaType: binary.mime_type || 'image/jpeg',
      scaleX,
      scaleY,
      origWidth,
      origHeight,
      sentWidth,
      sentHeight,
    };
  } catch (err) {
    console.warn('[ambient-ui] capture_screen failed:', err);
    return null;
  }
}

// T20b -- query the sidecar for the currently focused OS window
// (Chrome tab, VSCode, CapCut, etc.) so the LLM can answer
// "where do I click for X?" without the user having to specify
// the app. Returns null on any failure -- best-effort context.
export async function fetchPebbleForegroundApp(dispatch: PebbleDesktopDispatch, sidecarId: string): Promise<{ title: string; processName?: string } | null> {
  if (!isDesktopEnabled()) return null;
  try {
    const result = await Promise.race<unknown>([
      dispatch(sidecarId, 'list_windows', {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 800)),
    ]);
    const arr = Array.isArray(result) ? result : (result as { windows?: unknown }).windows;
    if (!Array.isArray(arr)) return null;
    for (const w of arr) {
      const ww = w as Record<string, unknown>;
      if (ww.is_foreground) {
        const title = String(ww.title ?? '').trim();
        const processName = ww.process_name ? String(ww.process_name) : undefined;
        if (!title && !processName) return null;
        return { title, processName };
      }
    }
    return null;
  } catch {
    return null;
  }
}
/**
 * The pebble's standing instructions for acting on the user's machine. Every
 * cycle through the pebble loop is a voice command: the user already
 * authorized whatever they asked for by saying it out loud. The model has been
 * observed adding extra "may I?" rounds and giving up halfway through
 * multi-step desktop actions; these directives short-circuit both failure
 * modes.
 *
 * With desktop.enabled off (#905) the desktop half is left out and the model
 * is told plainly that desktop control is off, rather than being told to use
 * tools it does not have.
 */
export function pebbleActionDirectives(): string[] {
  if (isDesktopEnabled()) {
    return [
      '# Acting on the user\'s machine — execute, don\'t ask',
      '',
      'A spoken request IS the authorization. When the user says "click X", "open Y", "send Z", "type ...", just DO it. Do not reply with "I need your permission first" / "shall I go ahead?" / "do you want me to ...?" — the user already said yes by speaking the request. The only exception is genuinely irreversible operations (deleting files, sending money, posting publicly to recipients) — for those, ask once. Clicking icons, opening apps, focusing windows, switching tabs, taking screenshots, navigating URLs are NOT in that category.',
      '',
      '**Prefer the efficient automation path — never click via the OS cursor when there\'s a structured alternative.**',
      '',
      '  - **Web apps** (Gmail, Notion, GitHub, the JARVIS dashboard, anything in a browser): use `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type`. These dispatch DOM events through CDP — no OS cursor involved, very reliable, very fast. The user can keep using their mouse for other things while you operate the page.',
      '',
      '  - **Native Windows apps** (Notepad, File Explorer, settings, dialogs, menus): `desktop_snapshot` to enumerate UI elements, then `desktop_click({element_id})`. Win32 UIA invokes the element directly via COM patterns where possible — no cursor move when the widget supports the Invoke pattern.',
      '',
      '  - **Open an app**: `desktop_launch_app({name: "Chrome"})` is faster and more reliable than clicking a desktop icon. Only fall back to clicking icons if launch_app doesn\'t resolve the app.',
      '',
      'The pebble is a *visual narrator only* — it flies to the action target so the user can see what JARVIS is doing, but it does NOT control the user\'s cursor. The user keeps full mouse freedom while you operate apps through the structured paths above.',
      '',
      'When the user asks for something that genuinely requires a click on a non-UIA surface (desktop icon, system tray, popup), prefer asking them to do it themselves rather than wrestling with coordinate clicks — coordinate clicks move the OS cursor and steal control from the user.',
      '',
      '**Sidecar is primary.** The Go sidecar is connected and exposes desktop / browser / filesystem / clipboard / system_info / screenshot capabilities. Tools auto-route to it — you never need to specify a `target` parameter unless you want to override. If a tool returns "Local desktop control is not available", that\'s the local-only path leaking through; mention it in your reply but try the same call again — the auto-route should pick up the connected sidecar on the second attempt.',
      '',
      'When you finish a multi-step task, give a short verbal confirmation ("Done — Chrome is up.") rather than re-narrating each step. The pebble already showed each step visually.',
      '',
    ];
  }
  return [
    '# Acting on the user\'s machine - execute, don\'t ask',
    '',
    'A spoken request IS the authorization. When the user asks for something in the browser ("open my inbox", "send Z", "type ..."), just DO it. Do not reply with "I need your permission first" / "shall I go ahead?" / "do you want me to ...?" - the user already said yes by speaking the request. The only exception is genuinely irreversible operations (deleting files, sending money, posting publicly to recipients) - for those, ask once. Switching tabs and navigating URLs are NOT in that category.',
    '',
    '  - **Web apps** (Gmail, Notion, GitHub, the JARVIS dashboard, anything in a browser): use `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type`. These dispatch DOM events through CDP - no OS cursor involved, very reliable, very fast. The user can keep using their mouse for other things while you operate the page.',
    '',
    'The pebble is a *visual narrator only* - it flies to the action target so the user can see what JARVIS is doing, but it does NOT control the user\'s cursor.',
    '',
    '**Desktop control is turned off on this Jarvis** (desktop.enabled: false). You cannot list windows, see the screen, click, type, take screenshots or open or focus apps outside the browser, and the desktop tools are not available. Do not try to reach the desktop another way. If the user asks for something on their desktop, say that desktop control is off and that they can turn it back on by setting desktop.enabled to true in config.yaml and restarting Jarvis.',
    '',
    'When you finish a multi-step task, give a short verbal confirmation ("Done - the page is open.") rather than re-narrating each step.',
    '',
  ];
}
