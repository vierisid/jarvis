/**
 * Desktop Controller — Windows Desktop Automation via Sidecar
 *
 * TCP JSON-RPC client that communicates with the desktop-bridge.exe sidecar.
 * Mirrors the BrowserController pattern: lazy connection, auto-launch,
 * snapshot with numbered element IDs, element cache for click/type by ID.
 */

import { createConnection, type Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import type { AppController, WindowInfo, UIElement } from './interface.ts';
import { launchSidecar, stopSidecar, isSidecarRunning, type RunningSidecar } from './sidecar-launcher.ts';

export type DesktopSnapshot = {
  window: { pid: number; title: string; className: string };
  elements: FlatElement[];
  totalElements: number;
};

export type FlatElement = {
  id: number;
  role: string;
  name: string;
  value: string | null;
  depth: number;
  isEnabled: boolean;
  bounds: UIElement['bounds'];
  properties: Record<string, unknown>;
};

const DEFAULT_PORT = 9224;
const MAX_SNAPSHOT_ELEMENTS = 60;

export class DesktopController implements AppController {
  private port: number;
  private host: string = 'localhost';
  private socket: Socket | null = null;
  private _connected = false;
  private runningSidecar: RunningSidecar | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';

  // Element cache from last snapshot (like BrowserController.elementCoords)
  private elementCache = new Map<number, UIElement>();
  private lastSnapshotWindow: { pid: number; title: string } | null = null;

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
  }

  // --- Connection lifecycle ---

  async connect(): Promise<void> {
    if (this._connected) return;

    // Check if sidecar is already running
    if (!(await isSidecarRunning(this.port))) {
      console.log('[DesktopController] Sidecar not running, launching...');
      this.runningSidecar = await launchSidecar(this.port);
      this.host = this.runningSidecar.host;
    }

    // Open TCP socket
    await this.openSocket();
    this._connected = true;
    console.log(`[DesktopController] Connected to sidecar on ${this.host}:${this.port}`);
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
    this.elementCache.clear();
    this.pending.clear();
    this.buffer = '';

    if (this.runningSidecar) {
      await stopSidecar(this.runningSidecar);
      this.runningSidecar = null;
    }

    console.log('[DesktopController] Disconnected');
  }

  get connected(): boolean {
    return this._connected;
  }

  // --- AppController interface ---

  async getActiveWindow(): Promise<WindowInfo> {
    await this.ensureConnected();
    const result = await this.send('getActiveWindow') as any;
    if (!result) throw new Error('No active window found');
    return this.toWindowInfo(result);
  }

  async listWindows(): Promise<WindowInfo[]> {
    await this.ensureConnected();
    const result = await this.send('listWindows') as any[];
    return result.map((w) => this.toWindowInfo(w));
  }

  async getWindowTree(pid: number): Promise<UIElement[]> {
    await this.ensureConnected();
    const result = await this.send('getWindowTree', { pid, depth: 5 }) as any;
    return this.parseElements(result.elements || []);
  }

  async clickElement(element: UIElement): Promise<void> {
    await this.ensureConnected();
    const id = parseInt(element.id, 10);
    await this.send('clickElement', { elementId: id });
  }

  async typeText(text: string): Promise<void> {
    await this.ensureConnected();
    await this.send('typeText', { text });
  }

  async pressKeys(keys: string[]): Promise<void> {
    await this.ensureConnected();
    await this.send('pressKeys', { keys });
  }

  async captureScreen(): Promise<Buffer> {
    await this.ensureConnected();
    const base64 = await this.send('captureScreen') as string;
    return Buffer.from(base64, 'base64');
  }

  async captureWindow(pid: number): Promise<Buffer> {
    await this.ensureConnected();
    const base64 = await this.send('captureWindow', { pid }) as string;
    return Buffer.from(base64, 'base64');
  }

  async focusWindow(pid: number): Promise<void> {
    await this.ensureConnected();
    await this.send('focusWindow', { pid });
  }

  // --- Extended methods (snapshot-based, like BrowserController) ---

  /**
   * Get a snapshot of a window's UI elements with sequential [id]s.
   * If no PID given, snapshots the active window.
   */
  async snapshot(pid?: number, depth: number = 5): Promise<DesktopSnapshot> {
    await this.ensureConnected();

    // Get target window
    let targetPid = pid;
    if (!targetPid) {
      const active = await this.send('getActiveWindow') as any;
      if (!active) throw new Error('No active window');
      targetPid = active.pid;
    }

    // Get UI tree
    const result = await this.send('getWindowTree', { pid: targetPid, depth }) as any;

    // Flatten tree into sequential IDs
    this.elementCache.clear();
    const flatElements: FlatElement[] = [];
    this.flattenTree(result.elements || [], 0, flatElements);

    this.lastSnapshotWindow = {
      pid: targetPid!,
      title: result.window?.title || '',
    };

    return {
      window: result.window || { pid: targetPid, title: '', className: '' },
      elements: flatElements.slice(0, MAX_SNAPSHOT_ELEMENTS),
      totalElements: flatElements.length,
    };
  }

  /**
   * Click a UI element by its snapshot [id].
   */
  async clickById(elementId: number): Promise<string> {
    await this.ensureConnected();

    const element = this.elementCache.get(elementId);
    if (!element) {
      return `Error: Element [${elementId}] not found. Run desktop_snapshot first.`;
    }

    await this.send('clickElement', { elementId });

    const label = element.name ? `"${element.name}"` : element.role;
    return `Clicked [${element.role}] ${label} (id: ${elementId})`;
  }

  /**
   * Type text, optionally clicking an element first.
   */
  async typeById(elementId: number | undefined, text: string): Promise<string> {
    await this.ensureConnected();

    if (elementId !== undefined) {
      const clickResult = await this.clickById(elementId);
      if (clickResult.startsWith('Error:')) return clickResult;
      // Brief pause after click
      await Bun.sleep(200);
    }

    await this.send('typeText', { text });

    const targetStr = elementId !== undefined ? ` into element [${elementId}]` : '';
    return `Typed "${text}"${targetStr}`;
  }

  /**
   * Launch a Windows application.
   */
  async launchApp(executable: string, args?: string): Promise<object> {
    await this.ensureConnected();
    return await this.send('launchApp', { executable, args: args || '' }) as object;
  }

  /**
   * Close a window by PID.
   */
  async closeWindow(pid: number): Promise<void> {
    await this.ensureConnected();
    await this.send('closeWindow', { pid });
  }

  /**
   * Drag one element onto another.
   */
  async dragElement(fromId: UIElement | number, toId: UIElement | number): Promise<void> {
    await this.ensureConnected();

    const fromNum = typeof fromId === 'number' ? fromId : parseInt(fromId.id, 10);
    const toNum = typeof toId === 'number' ? toId : parseInt(toId.id, 10);

    await this.send('dragElement', { fromId: fromNum, toId: toNum });
  }

  /**
   * Take a desktop screenshot and save to file.
   */
  async screenshotToFile(pid?: number, filePath: string = '/tmp/jarvis-desktop-screenshot.png'): Promise<string> {
    const buffer = pid ? await this.captureWindow(pid) : await this.captureScreen();
    writeFileSync(filePath, buffer);
    return filePath;
  }

  /**
   * Take a desktop screenshot and return raw base64 data (for vision/LLM).
   */
  async screenshotBase64(pid?: number): Promise<{ base64: string; mimeType: string }> {
    await this.ensureConnected();
    const method = pid ? 'captureWindow' : 'captureScreen';
    const base64 = await this.send(method, pid ? { pid } : {}) as string;
    return { base64, mimeType: 'image/png' };
  }

  // --- Private helpers ---

  private async ensureConnected(): Promise<void> {
    if (this._connected && this.socket && !this.socket.destroyed) {
      return;
    }

    // Connection went stale
    if (this._connected) {
      console.warn('[DesktopController] Connection stale, reconnecting...');
      this._connected = false;
      this.elementCache.clear();
      this.pending.clear();
      this.buffer = '';
    }

    await this.connect();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port }, () => {
        this.socket = socket;
        resolve();
      });

      socket.setEncoding('utf-8');

      socket.on('data', (chunk: string) => {
        this.buffer += chunk;
        this.processBuffer();
      });

      socket.on('error', (err) => {
        if (!this._connected) {
          reject(err);
        } else {
          console.error('[DesktopController] Socket error:', err.message);
          this._connected = false;
        }
      });

      socket.on('close', () => {
        this._connected = false;
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!this._connected && !this.socket) {
          socket.destroy();
          reject(new Error(`Failed to connect to sidecar on ${this.host}:${this.port}`));
        }
      }, 5000);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep incomplete last line in buffer
    this.buffer = lines.pop() || '';

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Strip UTF-8 BOM if present (C# can emit it)
      if (line.charCodeAt(0) === 0xFEFF) {
        line = line.slice(1);
      }

      try {
        const response = JSON.parse(line);
        const id = response.id;
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (response.error) {
            p.reject(new Error(response.error.message || 'Unknown error'));
          } else {
            p.resolve(response.result);
          }
        }
      } catch {
        console.warn('[DesktopController] Invalid JSON from sidecar:', line.slice(0, 100));
      }
    }
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected to sidecar'));
        return;
      }

      const id = this.nextRequestId++;
      const request = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: params || {},
        id,
      }) + '\n';

      this.pending.set(id, { resolve, reject });

      this.socket.write(request, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      // Timeout per request
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for response to ${method} (id: ${id})`));
        }
      }, 30_000);
    });
  }

  private flattenTree(elements: any[], depth: number, result: FlatElement[]): void {
    for (const el of elements) {
      const id = el.id;
      const uiElement: UIElement = {
        id: String(id),
        role: el.role || '',
        name: el.name || '',
        value: el.value || null,
        bounds: el.bounds || { x: 0, y: 0, width: 0, height: 0 },
        children: [],
        properties: el.properties || {},
      };

      this.elementCache.set(id, uiElement);

      result.push({
        id,
        role: el.role || '',
        name: el.name || '',
        value: el.value || null,
        depth,
        isEnabled: el.isEnabled !== false,
        bounds: uiElement.bounds,
        properties: uiElement.properties,
      });

      // Recurse into children
      if (el.children && el.children.length > 0) {
        this.flattenTree(el.children, depth + 1, result);
      }
    }
  }

  private toWindowInfo(raw: any): WindowInfo {
    return {
      pid: raw.pid || 0,
      title: raw.title || '',
      className: raw.className || '',
      bounds: raw.bounds || { x: 0, y: 0, width: 0, height: 0 },
      focused: raw.focused || false,
    };
  }

  private parseElements(raw: any[]): UIElement[] {
    return raw.map((el) => ({
      id: String(el.id),
      role: el.role || '',
      name: el.name || '',
      value: el.value || null,
      bounds: el.bounds || { x: 0, y: 0, width: 0, height: 0 },
      children: el.children ? this.parseElements(el.children) : [],
      properties: el.properties || {},
    }));
  }
}
