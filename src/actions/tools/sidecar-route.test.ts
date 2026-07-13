import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { routeToSidecar, setSidecarManagerRef, getSidecarManager } from './sidecar-route.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';

// The manager ref is module-global; restore it so other test files (which
// rely on no sidecar being connected) are unaffected.
const priorManager = getSidecarManager();
afterAll(() => {
  setSidecarManagerRef(priorManager as unknown as SidecarManager);
});

/**
 * Phase 0 honesty contract: a timed-out ("detached") RPC must never be
 * reported as background success for interactive tools — detached results
 * are only console-logged and never reach the model.
 */

function fakeManager(dispatchResult: unknown): SidecarManager {
  return {
    listSidecars: () => [{
      id: 'sc1',
      name: 'desktop-pc',
      connected: true,
      capabilities: ['desktop', 'browser', 'terminal'],
      unavailable_capabilities: [],
    }],
    dispatchRPC: async () => dispatchResult,
  } as unknown as SidecarManager;
}

describe('routeToSidecar detached handling', () => {
  beforeEach(() => {
    setSidecarManagerRef(fakeManager('detached'));
  });

  it('reports an honest timeout error for desktop tools instead of "running in the background"', async () => {
    const res = await routeToSidecar('desktop-pc', 'launch_app', { executable: 'notepad.exe' }, 'desktop');
    expect(res).toContain('Error');
    expect(res).toContain('do NOT assume it succeeded');
    expect(res).not.toContain('running in the background');
  });

  it('reports an honest timeout error for browser tools', async () => {
    const res = await routeToSidecar('desktop-pc', 'browser_navigate', { url: 'https://x.test' }, 'browser');
    expect(res).toContain('Error');
    expect(res).not.toContain('running in the background');
  });

  it('keeps fire-and-forget semantics for run_command, with an explicit no-output caveat', async () => {
    const res = await routeToSidecar('desktop-pc', 'run_command', { command: 'sleep 60' }, 'terminal');
    expect(res).toContain('still running in the background');
    expect(res).toContain('will NOT be reported back');
    expect(res).not.toContain('Error');
  });

  it('passes real results through untouched', async () => {
    setSidecarManagerRef(fakeManager({ success: true, pid: 42 }));
    const res = await routeToSidecar('desktop-pc', 'launch_app', {}, 'desktop');
    expect(JSON.parse(res)).toEqual({ success: true, pid: 42 });
  });
});
