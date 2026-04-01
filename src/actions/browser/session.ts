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

// JS function injected into the page to extract interactive elements
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
  document.querySelectorAll(sel).forEach((el) => {
    // Skip duplicates (child of already-captured parent)
    if (seen.has(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.width < 5 || rect.height < 5) return;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden') return;
    if (style.display === 'none') return;
    if (style.opacity === '0') return;

    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
    const attrs = {};
    for (const a of ['href', 'name', 'placeholder', 'type', 'aria-label', 'title', 'id', 'role', 'data-testid', 'contenteditable']) {
      const v = el.getAttribute(a);
      if (v) attrs[a] = v.slice(0, 200);
    }
    // Capture live value (JS property) for inputs — getAttribute('value') returns the HTML default
    if ('value' in el && el.value) attrs.value = String(el.value).slice(0, 200);
    els.push({
      _el: el,
      tag,
      text,
      attrs,
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2)
    });
  });

  // Assign sequential IDs and store DOM refs for later direct focus
  window.__jarvis_elements = els.map(e => e._el);
  els.forEach((el, i) => { el.id = i + 1; delete el._el; });

  // Get visible text, clean up whitespace
  let bodyText = document.body.innerText || '';
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
   */
  async click(elementId: number): Promise<string> {
    await this.ensureConnected();

    const coords = this.elementCoords.get(elementId);
    if (!coords) {
      return `Error: Element [${elementId}] not found. Run browser_snapshot first.`;
    }

    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: coords.x,
      y: coords.y,
      button: 'left',
      clickCount: 1,
    });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: coords.x,
      y: coords.y,
      button: 'left',
      clickCount: 1,
    });

    // Wait for navigation/changes
    await Bun.sleep(1000);

    return `Clicked element [${elementId}]`;
  }

  /**
   * Type text into an input element by its snapshot ID.
   * Optionally press Enter after typing.
   *
   * Uses DOM focus + targeted value clearing instead of coordinate-click + Ctrl+A.
   * This prevents misclicks from wiping the wrong field (e.g., typing subject
   * text into the To field in Gmail's compact compose window).
   */
  async type(elementId: number, text: string, submit: boolean = false): Promise<string> {
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
        // Clear existing content based on element type
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
          // For contenteditable divs, select all within this element only
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          // Delete the selection
          document.execCommand('delete', false, null);
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
      // Use Ctrl+A as fallback clearing (old behavior)
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2,
      });
    } else {
      await Bun.sleep(200);
    }

    // Insert text (like paste — much more reliable than char-by-char)
    await this.cdp.send('Input.insertText', { text });

    let result = `Typed "${text}" into element [${elementId}]`;

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
