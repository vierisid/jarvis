import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { DESKTOP_TOOLS } from './desktop.ts';
import { setSidecarManagerRef, resolveDefaultSidecar } from './sidecar-route.ts';
import type { SidecarInfo, SidecarCapability } from '../../sidecar/types.ts';

/**
 * Minimal mock of SidecarManager for routing tests.
 * Only implements listSidecars() — dispatchRPC is not needed for resolution logic.
 */
function createMockManager(sidecars: SidecarInfo[]) {
  return {
    listSidecars: () => sidecars,
    // Stub the rest of the Service interface so TS is happy
    dispatchRPC: async () => { throw new Error('mock: dispatchRPC not wired'); },
  } as any;
}

function makeSidecar(overrides: Partial<SidecarInfo> & { id: string; name: string }): SidecarInfo {
  return {
    enrolled_at: '2024-01-01T00:00:00Z',
    last_seen_at: null,
    status: 'enrolled',
    connected: false,
    ...overrides,
  };
}

describe('DESKTOP_TOOLS', () => {
  test('contains 9 desktop tools', () => {
    expect(DESKTOP_TOOLS).toHaveLength(9);
  });

  test('all have desktop category', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(tool.category).toBe('desktop');
    }
  });

  test('tool names match expected desktop tools', () => {
    const names = DESKTOP_TOOLS.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'desktop_click',
      'desktop_find_element',
      'desktop_focus_window',
      'desktop_launch_app',
      'desktop_list_windows',
      'desktop_press_keys',
      'desktop_screenshot',
      'desktop_snapshot',
      'desktop_type',
    ]);
  });

  test('all tools have execute functions', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  test('all tools have descriptions', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  test('all tools have target parameter', () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(tool.parameters.target).toBeDefined();
      expect(tool.parameters.target!.type).toBe('string');
    }
  });

  test('returns sidecar-not-initialized error without target when manager is null', async () => {
    // Ensure no manager is set (default state)
    setSidecarManagerRef(null as any);
    for (const tool of DESKTOP_TOOLS) {
      const result = await tool.execute({});
      expect(String(result)).toContain('Sidecar system not initialized');
    }
  });
});

describe('resolveDefaultSidecar', () => {
  afterEach(() => {
    // Reset to null after each test
    setSidecarManagerRef(null as any);
  });

  test('returns error when sidecar manager is not initialized', () => {
    setSidecarManagerRef(null as any);
    const result = resolveDefaultSidecar('desktop');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not initialized');
    }
  });

  test('returns error when no sidecars are enrolled', () => {
    setSidecarManagerRef(createMockManager([]));
    const result = resolveDefaultSidecar('desktop');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No sidecars enrolled');
    }
  });

  test('returns error when sidecars enrolled but none connected', () => {
    setSidecarManagerRef(createMockManager([
      makeSidecar({ id: 's1', name: 'my-pc', connected: false, capabilities: ['desktop'] }),
    ]));
    const result = resolveDefaultSidecar('desktop');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No sidecars are currently connected');
      expect(result.error).toContain('1 sidecar(s) enrolled but offline');
    }
  });

  test('returns error when connected but no matching capability', () => {
    setSidecarManagerRef(createMockManager([
      makeSidecar({ id: 's1', name: 'my-pc', connected: true, capabilities: ['terminal', 'filesystem'] }),
    ]));
    const result = resolveDefaultSidecar('desktop');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No connected sidecar has the "desktop" capability');
      expect(result.error).toContain('terminal');
    }
  });

  test('returns sidecar when exactly one connected with matching capability', () => {
    const sidecar = makeSidecar({ id: 's1', name: 'my-pc', connected: true, capabilities: ['desktop', 'terminal'] });
    setSidecarManagerRef(createMockManager([sidecar]));
    const result = resolveDefaultSidecar('desktop');
    expect('sidecar' in result).toBe(true);
    if ('sidecar' in result) {
      expect(result.sidecar.id).toBe('s1');
      expect(result.sidecar.name).toBe('my-pc');
    }
  });

  test('returns error when multiple connected sidecars have matching capability', () => {
    setSidecarManagerRef(createMockManager([
      makeSidecar({ id: 's1', name: 'home-pc', connected: true, capabilities: ['desktop'] }),
      makeSidecar({ id: 's2', name: 'work-pc', connected: true, capabilities: ['desktop'] }),
    ]));
    const result = resolveDefaultSidecar('desktop');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Multiple sidecars');
      expect(result.error).toContain('home-pc');
      expect(result.error).toContain('work-pc');
      expect(result.error).toContain('Specify a "target"');
    }
  });

  test('excludes sidecars with unavailable capability from auto-resolution', () => {
    setSidecarManagerRef(createMockManager([
      makeSidecar({
        id: 's1', name: 'my-pc', connected: true,
        capabilities: ['desktop'],
        unavailable_capabilities: [{ name: 'desktop', reason: 'accessibility not enabled' }],
      }),
    ]));
    const result = resolveDefaultSidecar('desktop');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      // Should not find the sidecar since its desktop capability is unavailable
      expect(result.error).toContain('No connected sidecar has the "desktop" capability');
    }
  });

  test('resolves correct sidecar when one has capability unavailable and another does not', () => {
    setSidecarManagerRef(createMockManager([
      makeSidecar({
        id: 's1', name: 'broken-pc', connected: true,
        capabilities: ['desktop'],
        unavailable_capabilities: [{ name: 'desktop', reason: 'no accessibility' }],
      }),
      makeSidecar({
        id: 's2', name: 'working-pc', connected: true,
        capabilities: ['desktop'],
      }),
    ]));
    const result = resolveDefaultSidecar('desktop');
    expect('sidecar' in result).toBe(true);
    if ('sidecar' in result) {
      expect(result.sidecar.id).toBe('s2');
      expect(result.sidecar.name).toBe('working-pc');
    }
  });

  test('resolves screenshot capability independently from desktop', () => {
    setSidecarManagerRef(createMockManager([
      makeSidecar({ id: 's1', name: 'my-pc', connected: true, capabilities: ['screenshot'] }),
    ]));
    const desktopResult = resolveDefaultSidecar('desktop');
    expect('error' in desktopResult).toBe(true);

    const screenshotResult = resolveDefaultSidecar('screenshot');
    expect('sidecar' in screenshotResult).toBe(true);
    if ('sidecar' in screenshotResult) {
      expect(screenshotResult.sidecar.id).toBe('s1');
    }
  });

  test('ignores offline sidecars even if they have the capability', () => {
    setSidecarManagerRef(createMockManager([
      makeSidecar({ id: 's1', name: 'offline-pc', connected: false, capabilities: ['desktop'] }),
      makeSidecar({ id: 's2', name: 'online-pc', connected: true, capabilities: ['desktop'] }),
    ]));
    const result = resolveDefaultSidecar('desktop');
    expect('sidecar' in result).toBe(true);
    if ('sidecar' in result) {
      expect(result.sidecar.id).toBe('s2');
    }
  });
});
