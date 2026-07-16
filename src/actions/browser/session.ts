/**
 * Browser Controller — High-level browser automation
 *
 * Wraps CDPClient with user-friendly operations:
 * navigate, snapshot (interactive elements with IDs), click, type, screenshot.
 *
 * The snapshot approach: each interactive element gets a numeric [id].
 * The LLM sees these IDs and references them in click/type commands.
 */

import { CDPClient } from './cdp.ts';
import { STEALTH_SCRIPT } from './stealth.ts';
import { launchChrome, stopChrome, type RunningBrowser } from './chrome-launcher.ts';
import { parseKeyCombo, SUPPORTED_KEYS_HINT } from './keys.ts';

export type PageElement = {
  id: number;
  tag: string;
  text: string;
  attrs: Record<string, string>;
};

export type PageSnapshot = {
  title: string;
  url: string;
  text: string;
  elements: PageElement[];
};

// JS function injected into the page to extract interactive elements.
// Traverses same-origin iframes (Google Docs, Gmail compose, embedded
// editors) with click coordinates offset to top-page space. Cross-origin
// frames are skipped (contentDocument is inaccessible). Mirrored in the Go
// sidecar (sidecar/browser_snapshot.go) — change both together.
const SNAPSHOT_SCRIPT = `(() => {
  const els = [];
  const seen = new WeakSet();
  const sel = [
    'a', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="textbox"]',
    '[role="combobox"]', '[role="menuitem"]', '[role="option"]',
    '[role="row"]', '[role="gridcell"]',
    '[onclick]', '[contenteditable="true"]', '[tabindex="0"]',
    '[data-testid]'
  ].join(', ');

  // Collect same-origin documents: the top document plus nested iframes,
  // each with the cumulative offset of its viewport in top-page coordinates.
  const frames = [];
  const collectFrames = (doc, ox, oy, depth) => {
    frames.push({ doc, ox, oy });
    if (depth >= 3 || frames.length >= 10) return;
    for (const f of doc.querySelectorAll('iframe, frame')) {
      let child = null;
      try { child = f.contentDocument; } catch { continue; }
      if (!child) continue;
      const r = f.getBoundingClientRect();
      collectFrames(child, ox + r.x, oy + r.y, depth + 1);
    }
  };
  collectFrames(document, 0, 0, 0);

  for (const frame of frames) {
    const doc = frame.doc;
    const win = doc.defaultView || window;
    const inFrame = doc !== document;
    doc.querySelectorAll(sel).forEach((el) => {
      // Skip duplicates (child of already-captured parent)
      if (seen.has(el)) return;
      seen.add(el);

      const rect = el.getBoundingClientRect();
      const isTypingTarget = el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
      const style = win.getComputedStyle(el);
      if (style.display === 'none') return;
      if (isTypingTarget) {
        // Keep typing targets even when tiny, clipped, or transparent —
        // editors (Google Docs) hide their real input in an offscreen iframe.
      } else {
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.width < 5 || rect.height < 5) return;
        if (style.visibility === 'hidden') return;
        if (style.opacity === '0') return;
      }

      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
      const attrs = {};
      for (const a of ['href', 'name', 'placeholder', 'type', 'aria-label', 'title', 'id', 'role', 'data-testid', 'contenteditable']) {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v.slice(0, 200);
      }
      // Capture live value (JS property) for inputs — getAttribute('value') returns the HTML default
      if ('value' in el && el.value) attrs.value = String(el.value).slice(0, 200);
      if (inFrame) attrs.iframe = 'true';
      els.push({
        _el: el,
        tag,
        text,
        attrs,
        x: Math.round(frame.ox + rect.x + rect.width / 2),
        y: Math.round(frame.oy + rect.y + rect.height / 2)
      });
    });
  }

  // Assign sequential IDs and store DOM refs for later direct focus
  window.__jarvis_elements = els.map(e => e._el);
  els.forEach((el, i) => { el.id = i + 1; delete el._el; });

  // Get visible text (top document first, then same-origin frames), clean up whitespace.
  // document.body can be null on challenge/error pages (WAF "checking your browser"
  // interstitials) — guard so the snapshot returns empty text instead of throwing,
  // which lets callers detect the bot-wall rather than seeing an opaque error.
  let bodyText = (document.body && document.body.innerText) || '';
  for (const frame of frames) {
    if (frame.doc === document) continue;
    const t = frame.doc.body && frame.doc.body.innerText;
    if (t && t.trim()) bodyText += '\\n' + t;
  }
  bodyText = bodyText.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000);

  return {
    title: document.title,
    url: location.href,
    text: bodyText,
    elements: els
  };
})()`;

export class BrowserController {
  private cdp: CDPClient;
  private port: number;
  private profileDir: string | undefined;
  private _connected = false;
  private runningBrowser: RunningBrowser | null = null;
  // Coordinates stored from last snapshot — not sent to LLM
  private elementCoords = new Map<number, { x: number; y: number }>();

  constructor(port: number = 9222, profileDir?: string) {
    this.cdp = new CDPClient();
    this.port = port;
    this.profileDir = profileDir;
  }

  /**
   * Check if Chrome CDP is already reachable on the debug port.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Connect to Chrome. If Chrome isn't running, auto-launches it
   * with CDP enabled and an isolated profile. No user setup required.
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    // browser.local: false is enforced HERE, not only in launchChrome:
    // connect() first probes the CDP port and attaches to whatever is
    // already listening, so on a shared host a guard on launch alone would
    // let the agent adopt ANY process bound to 127.0.0.1:<port> - including
    // another tenant's. No local CDP connection at all when disabled.
    const { isLocalBrowserDisabled } = await import('../tools/local-tools-guard.ts');
    if (isLocalBrowserDisabled()) {
      throw new Error('The local browser is disabled on this machine (browser.local: false). Use a sidecar browser instead.');
    }

    // If Chrome isn't running, launch it automatically
    if (!(await this.isAvailable())) {
      console.log('[BrowserController] Chrome not detected, launching automatically...');
      this.runningBrowser = await launchChrome(this.port, this.profileDir);
    }

    // Discover page targets
    const listRes = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    if (!listRes.ok) {
      throw new Error('Chrome CDP not reachable after launch');
    }

    const targets = await listRes.json() as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;

    let pageTarget = targets.find(t => t.type === 'page');

    if (!pageTarget) {
      // Create a new tab
      const newRes = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`);
      pageTarget = await newRes.json() as any;
    }

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('No page target found and could not create one');
    }

    // Connect CDP to the page
    await this.cdp.connect(pageTarget.webSocketDebuggerUrl);

    // Enable required CDP domains
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('DOM.enable');

    // Inject stealth scripts for all future navigations
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: STEALTH_SCRIPT,
    });

    this._connected = true;
    console.log('[BrowserController] Connected to Chrome');
  }

  /**
   * Navigate to a URL and wait for the page to load.
   */
  async navigate(url: string): Promise<PageSnapshot> {
    await this.ensureConnected();

    const loadPromise = this.cdp.waitForEvent('Page.loadEventFired', 30000);

    try {
      await this.cdp.send('Page.navigate', { url });
    } catch (err) {
      // If navigate fails, suppress the dangling loadPromise timeout
      loadPromise.catch(() => {});
      throw err;
    }

    try {
      await loadPromise;
    } catch {
      // Page.loadEventFired timeout — page may still be usable (SPAs, slow loads)
      console.warn(`[BrowserController] Page load timeout for ${url}, continuing anyway`);
    }

    // Wait for JS to settle
    await Bun.sleep(800);

    return this.snapshot();
  }

  /**
   * Get a snapshot of the current page: text content + numbered interactive elements.
   */
  async snapshot(): Promise<PageSnapshot> {
    await this.ensureConnected();

    const result = await this.cdp.send('Runtime.evaluate', {
      expression: SNAPSHOT_SCRIPT,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`Snapshot failed: ${JSON.stringify(result.exceptionDetails)}`);
    }

    const data = result.result.value as PageSnapshot & {
      elements: Array<PageElement & { x: number; y: number }>;
    };

    // Store coordinates locally, strip from LLM-facing data
    this.elementCoords.clear();
    const cleanElements: PageElement[] = [];

    for (const el of data.elements) {
      this.elementCoords.set(el.id, { x: el.x, y: el.y });
      cleanElements.push({
        id: el.id,
        tag: el.tag,
        text: el.text,
        attrs: el.attrs,
      });
    }

    return {
      title: data.title,
      url: data.url,
      text: data.text,
      elements: cleanElements,
    };
  }

  /**
   * Click an element by its snapshot ID.
   * options.button: 'left' (default) or 'right' (context menu).
   * options.double: double-click instead of single click.
   */
  async click(
    elementId: number,
    options: { button?: 'left' | 'right'; double?: boolean } = {},
  ): Promise<string> {
    await this.ensureConnected();

    const coords = this.elementCoords.get(elementId);
    if (!coords) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }

    const button = options.button === 'right' ? 'right' : 'left';

    // Move the pointer onto the element first — hover-sensitive UIs
    // (menus, message toolbars) expect mouseover before the press.
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: coords.x,
      y: coords.y,
    });

    const clicks = options.double ? 2 : 1;
    for (let count = 1; count <= clicks; count++) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: coords.x,
        y: coords.y,
        button,
        clickCount: count,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: coords.x,
        y: coords.y,
        button,
        clickCount: count,
      });
    }

    // Wait for navigation/changes
    await Bun.sleep(1000);

    const kind = options.double ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked';
    return `${kind} element [${elementId}]`;
  }

  /**
   * Hover the pointer over an element by its snapshot ID (trusted CDP mouse
   * move). Reveals hover-only UI like message action toolbars. The revealed
   * elements only show up in a NEW snapshot taken after this call.
   */
  async hover(elementId: number): Promise<string> {
    await this.ensureConnected();

    const coords = this.elementCoords.get(elementId);
    if (!coords) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }

    // Approach from a nearby point so mouseenter/mouseover always fire,
    // even if the pointer already sat on the target coordinates.
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.max(0, coords.x - 10),
      y: Math.max(0, coords.y - 10),
    });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: coords.x,
      y: coords.y,
    });

    // Give the app time to render hover-triggered UI
    await Bun.sleep(600);

    return `Hovering over element [${elementId}]. Take a browser_snapshot to see any hover-revealed elements, then act before moving the mouse elsewhere.`;
  }

  /**
   * Press a key or key combination (trusted CDP key events), e.g. "Enter",
   * "Escape", "Tab", "ArrowDown", "Ctrl+K", "Shift+Enter". Keys go to the
   * currently focused element.
   */
  async pressKey(combo: string): Promise<string> {
    await this.ensureConnected();

    const parsed = parseKeyCombo(combo);
    if (!parsed) {
      return `Error: Unsupported key "${combo}". Supported: ${SUPPORTED_KEYS_HINT}.`;
    }

    const base = {
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.keyCode,
      nativeVirtualKeyCode: parsed.keyCode,
      modifiers: parsed.modifiers,
    };

    await this.cdp.send('Input.dispatchKeyEvent', {
      type: parsed.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(parsed.text ? { text: parsed.text } : {}),
    });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });

    // Let the app react (menu open, mode switch, etc.)
    await Bun.sleep(300);

    return `Pressed ${parsed.display}`;
  }

  /**
   * Type text into an input element by its snapshot ID.
   * Optionally press Enter after typing.
   *
   * By default the element's existing content is CLEARED first (replace
   * semantics). Pass append=true to keep it and insert at the end instead.
   *
   * Uses DOM focus + targeted value clearing instead of coordinate-click + Ctrl+A.
   * This prevents misclicks from wiping the wrong field (e.g., typing subject
   * text into the To field in Gmail's compact compose window).
   */
  async type(
    elementId: number,
    text: string,
    submit: boolean = false,
    append: boolean = false,
  ): Promise<string> {
    await this.ensureConnected();

    const coords = this.elementCoords.get(elementId);
    if (!coords) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }

    // Focus the element via DOM (more reliable than coordinate click for typing)
    const focusResult = await this.cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = window.__jarvis_elements && window.__jarvis_elements[${elementId - 1}];
        if (!el) return 'not_found';
        el.focus();
        const append = ${append};
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          if (append) {
            // Move the caret to the end so the insert lands after existing text
            try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
          } else {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
          // Use the element's OWN document/window — the element may live
          // inside a same-origin iframe (Google Docs, Gmail compose), where
          // the top document's selection can't reach it.
          const doc = el.ownerDocument || document;
          const win = doc.defaultView || window;
          const range = doc.createRange();
          range.selectNodeContents(el);
          const sel = win.getSelection();
          sel.removeAllRanges();
          if (append) {
            // Collapse to the end of the element's content — insert appends
            range.collapse(false);
            sel.addRange(range);
          } else {
            // Select all within this element only, then delete the selection
            sel.addRange(range);
            doc.execCommand('delete', false, null);
          }
        }
        return 'ok';
      })()`,
      returnByValue: true,
    });

    const focusStatus = focusResult?.result?.value;
    if (focusStatus === 'not_found') {
      // Fallback: coordinate-based click (element refs may have been lost on navigation)
      const clickResult = await this.click(elementId);
      if (clickResult.startsWith('Error:')) return clickResult;
      await Bun.sleep(200);
      if (!append) {
        // Use Ctrl+A as fallback clearing (old behavior)
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'a', code: 'KeyA',
          windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
        });
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'a', code: 'KeyA',
          windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
        });
      }
    } else {
      await Bun.sleep(200);
    }

    // Insert text (like paste — much more reliable than char-by-char)
    await this.cdp.send('Input.insertText', { text });

    let result = `${append ? 'Appended' : 'Typed'} "${text}" into element [${elementId}]`;

    if (submit) {
      await Bun.sleep(100);
      await this.pressEnter();
      // Wait for page load after submit
      await Bun.sleep(2000);
      result += ' and pressed Enter';
    }

    return result;
  }

  /**
   * Press Enter key.
   */
  async pressEnter(): Promise<void> {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'char',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }

  /**
   * Scroll the page up or down.
   * direction: 'down' or 'up'
   * amount: pixels to scroll (default: one viewport height)
   */
  async scroll(direction: 'up' | 'down' = 'down', amount?: number): Promise<string> {
    await this.ensureConnected();

    const viewportHeight = (await this.evaluate('window.innerHeight') as number) || 600;
    const scrollAmount = amount ?? viewportHeight;

    const pixels = direction === 'down' ? scrollAmount : -scrollAmount;

    await this.evaluate(`window.scrollBy(0, ${pixels})`);
    await Bun.sleep(500); // Wait for lazy-loaded content

    return `Scrolled ${direction} by ${scrollAmount}px`;
  }

  /**
   * Upload a file to a <input type="file"> element on the page.
   * Uses CDP DOM.setFileInputFiles to bypass the native file picker.
   * If no selector is provided, finds the first visible file input.
   */
  async uploadFile(filePath: string, selector?: string): Promise<string> {
    await this.ensureConnected();

    // Resolve the file input element
    const query = selector || 'input[type="file"]';
    const doc = await this.cdp.send('DOM.getDocument');
    const node = await this.cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: query,
    });

    if (!node.nodeId) {
      return `Error: No file input found matching "${query}". Click the upload/attach button first to trigger the file input.`;
    }

    // Set the file on the input element via CDP
    try {
      await this.cdp.send('DOM.setFileInputFiles', {
        files: [filePath],
        nodeId: node.nodeId,
      });
    } catch (err) {
      return `Error setting file: ${err instanceof Error ? err.message : String(err)}`;
    }

    await Bun.sleep(1000); // Wait for the app to process the file

    return `Uploaded file "${filePath}" to file input`;
  }

  /**
   * Take a screenshot and save to a file.
   */
  async screenshot(filePath: string = '/tmp/jarvis-screenshot.png'): Promise<string> {
    await this.ensureConnected();

    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(result.data, 'base64');

    await Bun.write(filePath, buffer);
    return filePath;
  }

  /**
   * Take a screenshot and return raw base64 data (for vision/LLM).
   */
  async screenshotBuffer(): Promise<{ base64: string; mimeType: string }> {
    await this.ensureConnected();
    const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    return { base64: result.data, mimeType: 'image/png' };
  }

  /**
   * Evaluate arbitrary JavaScript in the page context.
   */
  async evaluate(expression: string): Promise<unknown> {
    await this.ensureConnected();

    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      throw new Error(`JS error: ${JSON.stringify(result.exceptionDetails)}`);
    }

    return result.result.value;
  }

  /**
   * Disconnect from Chrome. If we auto-launched Chrome, stop it too.
   */
  async disconnect(): Promise<void> {
    if (this._connected) {
      await this.cdp.close();
      this._connected = false;
      this.elementCoords.clear();
      console.log('[BrowserController] Disconnected');
    }

    // Stop the Chrome process we launched (if any)
    if (this.runningBrowser) {
      await stopChrome(this.runningBrowser);
      this.runningBrowser = null;
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  private async ensureConnected(): Promise<void> {
    if (this._connected && !this.cdp.isOpen) {
      // Connection went stale — reset and reconnect
      console.warn('[BrowserController] CDP connection stale, reconnecting...');
      this._connected = false;
      this.elementCoords.clear();
    }

    if (!this._connected) {
      await this.connect();
    }
  }
}
