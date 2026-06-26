/**
 * Tests for the Observer Layer.
 *
 * Host-sensing observers (file watcher, clipboard, process monitor, desktop
 * notifications) moved to the sidecar (sidecar/observers.go) in the ambient
 * model, so this only covers the coordinator (ObserverManager) and the
 * remaining account-level integrations (Calendar, Email).
 */

import { test, expect, describe } from 'bun:test';
import {
  ObserverManager,
  CalendarSync,
  EmailSync,
  type Observer,
  type ObserverEvent,
  type ObserverEventHandler,
} from './index';

/** Minimal in-memory observer used to exercise ObserverManager. */
class FakeObserver implements Observer {
  name: string;
  private running = false;
  private handler: ObserverEventHandler | null = null;

  constructor(name: string) {
    this.name = name;
  }
  async start(): Promise<void> {
    this.running = true;
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  isRunning(): boolean {
    return this.running;
  }
  onEvent(handler: ObserverEventHandler): void {
    this.handler = handler;
  }
  emit(event: ObserverEvent): void {
    this.handler?.(event);
  }
}

describe('ObserverManager', () => {
  test('registers observers', () => {
    const manager = new ObserverManager();
    manager.register(new FakeObserver('fake'));
    expect(manager.listObservers()).toEqual(['fake']);
  });

  test('propagates event handler to registered observers', () => {
    const manager = new ObserverManager();
    const fake = new FakeObserver('fake');
    manager.register(fake);

    const received: ObserverEvent[] = [];
    manager.setEventHandler((e) => received.push(e));

    fake.emit({ type: 'fake', data: { ok: true }, timestamp: 1 });
    expect(received).toHaveLength(1);
    expect(received[0]!.data.ok).toBe(true);
  });

  test('starts and stops all observers', async () => {
    const manager = new ObserverManager();
    manager.register(new FakeObserver('a'));
    manager.register(new FakeObserver('b'));

    await manager.startAll();
    expect(manager.getStatus()).toEqual({ a: true, b: true });

    await manager.stopAll();
    expect(manager.getStatus()).toEqual({ a: false, b: false });
  });

  test('starts and stops individual observers', async () => {
    const manager = new ObserverManager();
    manager.register(new FakeObserver('a'));

    await manager.startObserver('a');
    expect(manager.getStatus()['a']).toBe(true);

    await manager.stopObserver('a');
    expect(manager.getStatus()['a']).toBe(false);
  });
});

describe('Integration observers', () => {
  test('CalendarSync starts and stops', async () => {
    const sync = new CalendarSync();
    expect(sync.isRunning()).toBe(false);

    await sync.start();
    expect(sync.isRunning()).toBe(true);

    await sync.stop();
    expect(sync.isRunning()).toBe(false);
  });

  test('EmailSync starts and stops', async () => {
    const sync = new EmailSync();
    expect(sync.isRunning()).toBe(false);

    await sync.start();
    expect(sync.isRunning()).toBe(true);

    await sync.stop();
    expect(sync.isRunning()).toBe(false);
  });
});
