import { test, expect, describe } from 'bun:test';
import { DesktopController } from './desktop-controller.ts';

describe('DesktopController', () => {
  for (const method of ['clickById', 'typeById'] as const) test(`${method} cannot return success for a missing element`, async () => {
    const ctrl = new DesktopController();
    let calls = 0;
    // No local Windows service is needed: only the outbound command is fake.
    (ctrl as any).ensureConnected = async () => {};
    (ctrl as any).send = async () => { calls++; };
    await expect(method === 'clickById' ? ctrl.clickById(99) : ctrl.typeById(99, 'test')).rejects.toMatchObject({
      outcome: { status: 'blocked', code: 'DESKTOP_ELEMENT_NOT_FOUND', effect: 'not_started' },
    });
    expect(calls).toBe(0);
  });
  test('constructor accepts custom port', () => {
    const ctrl = new DesktopController(9224);
    expect(ctrl).toBeDefined();
    expect(ctrl.connected).toBe(false);
  });

  test('constructor uses default port', () => {
    const ctrl = new DesktopController();
    expect(ctrl).toBeDefined();
    expect(ctrl.connected).toBe(false);
  });

  test('constructor accepts different port', () => {
    const ctrl = new DesktopController(9999);
    expect(ctrl).toBeDefined();
  });

  test('starts disconnected', () => {
    const ctrl = new DesktopController();
    expect(ctrl.connected).toBe(false);
  });
});
