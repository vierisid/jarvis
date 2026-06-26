/**
 * Observer Layer - Monitors system events and emits observations to the Vault
 *
 * All observers implement a common interface and emit standardized events.
 */

// Common Observer Interface
export type ObserverEvent = {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
};

export type ObserverEventHandler = (event: ObserverEvent) => void;

export interface Observer {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  onEvent(handler: ObserverEventHandler): void;
}

// Account-level integration observers. Host-sensing observers (file watcher,
// clipboard, process monitor, desktop notifications) moved to the sidecar in
// the ambient/pebble model — see StartObservers in sidecar/observers.go.
export { CalendarSync } from './calendar';
export { EmailSync } from './email';

/**
 * ObserverManager - Centralized coordinator for all observers
 */
export class ObserverManager {
  private observers: Map<string, Observer> = new Map();
  private eventHandler: ObserverEventHandler | null = null;

  /**
   * Register a new observer
   */
  register(observer: Observer): void {
    this.observers.set(observer.name, observer);

    // If we already have a handler, apply it to the new observer
    if (this.eventHandler) {
      observer.onEvent(this.eventHandler);
    }

    console.log(`[ObserverManager] Registered observer: ${observer.name}`);
  }

  /**
   * Set the global event handler for all observers
   * This is typically the Vault's observation ingestion function
   */
  setEventHandler(handler: ObserverEventHandler): void {
    this.eventHandler = handler;

    // Apply handler to all registered observers
    for (const observer of this.observers.values()) {
      observer.onEvent(handler);
    }

    console.log(`[ObserverManager] Event handler configured for ${this.observers.size} observers`);
  }

  /**
   * Start all registered observers
   */
  async startAll(): Promise<void> {
    console.log('[ObserverManager] Starting all observers...');

    const promises = Array.from(this.observers.values()).map(async (observer) => {
      try {
        await observer.start();
        console.log(`[ObserverManager] ✓ Started ${observer.name}`);
      } catch (error) {
        console.error(`[ObserverManager] ✗ Failed to start ${observer.name}:`, error);
      }
    });

    await Promise.all(promises);
    console.log('[ObserverManager] All observers started');
  }

  /**
   * Stop all registered observers
   */
  async stopAll(): Promise<void> {
    console.log('[ObserverManager] Stopping all observers...');

    const promises = Array.from(this.observers.values()).map(async (observer) => {
      try {
        await observer.stop();
        console.log(`[ObserverManager] ✓ Stopped ${observer.name}`);
      } catch (error) {
        console.error(`[ObserverManager] ✗ Failed to stop ${observer.name}:`, error);
      }
    });

    await Promise.all(promises);
    console.log('[ObserverManager] All observers stopped');
  }

  /**
   * Start a specific observer by name
   */
  async startObserver(name: string): Promise<void> {
    const observer = this.observers.get(name);
    if (!observer) {
      throw new Error(`Observer not found: ${name}`);
    }

    if (observer.isRunning()) {
      console.log(`[ObserverManager] Observer ${name} is already running`);
      return;
    }

    await observer.start();
    console.log(`[ObserverManager] Started ${name}`);
  }

  /**
   * Stop a specific observer by name
   */
  async stopObserver(name: string): Promise<void> {
    const observer = this.observers.get(name);
    if (!observer) {
      throw new Error(`Observer not found: ${name}`);
    }

    if (!observer.isRunning()) {
      console.log(`[ObserverManager] Observer ${name} is not running`);
      return;
    }

    await observer.stop();
    console.log(`[ObserverManager] Stopped ${name}`);
  }

  /**
   * Get running status of all observers
   */
  getStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [name, observer] of this.observers) {
      status[name] = observer.isRunning();
    }
    return status;
  }

  /**
   * List all registered observer names
   */
  listObservers(): string[] {
    return Array.from(this.observers.keys());
  }
}
