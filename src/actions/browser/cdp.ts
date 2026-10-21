/**
 * CDP Client — Low-level Chrome DevTools Protocol WebSocket
 *
 * Handles command/response pairs and event subscriptions over
 * a single CDP target (page) WebSocket connection.
 */

type CDPEventHandler = (params: Record<string, unknown>) => void;

export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private eventHandlers = new Map<string, Set<CDPEventHandler>>();

  /**
   * Connect to a CDP target by its WebSocket debugger URL.
   */
  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => resolve();

      this.ws.onerror = () => reject(new Error('CDP WebSocket connection failed'));

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.id !== undefined) {
            // Command response
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) {
                p.reject(new Error(`CDP error: ${msg.error.message}`));
              } else {
                p.resolve(msg.result);
              }
            }
          } else if (msg.method) {
            // Event notification
            const handlers = this.eventHandlers.get(msg.method);
            if (handlers) {
              for (const h of handlers) h(msg.params ?? {});
            }
          }
        } catch (err) {
          console.error('[CDP] Failed to parse message:', err);
        }
      };

      this.ws.onclose = () => {
        for (const { reject: r } of this.pending.values()) {
          r(new Error('CDP connection closed'));
        }
        this.pending.clear();
      };
    });
  }

  /**
   * Send a CDP command and wait for its response.
   */
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected');
    }

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * Subscribe to a CDP event.
   */
  on(event: string, handler: CDPEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Unsubscribe from a CDP event.
   */
  off(event: string, handler: CDPEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Wait for a specific CDP event to fire.
   */
  async waitForEvent(event: string, timeout = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timeout waiting for ${event}`));
      }, timeout);

      const handler = (params: Record<string, unknown>) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };

      this.on(event, handler);
    });
  }

  /**
   * Close the WebSocket connection.
   */
  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    // Fail every call still waiting for its answer. A caller holding the
    // snapshot lock releases it in a finally that only runs once its call
    // settles, and the close event cannot be relied on to do this: Bun 1.3
    // fires onclose inside ws.close(), Bun 1.4 fires it later.
    for (const { reject } of this.pending.values()) {
      reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
