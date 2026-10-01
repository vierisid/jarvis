/**
 * #602 - the main registry's browser tools now bind what was reviewed, and the
 * binding has to be the RIGHT one for a dual-routed tool.
 *
 * `createBrowserTools` (the background agent's set) binds one controller and
 * can only run locally. These tools route to a sidecar whenever one resolves,
 * so the guard that the background set uses would refuse every remote browser
 * call on a sidecar-only machine - and a guard that demands a live local
 * connection at review time would kill every call on a cold daemon that
 * connects lazily. Both of those were real: this file pins the shape that is
 * neither.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  browserClickTool, browserTypeTool, browserHoverTool,
  browserNavigateTool, browserScrollTool, browserPressKeyTool, browserEvaluateTool,
} from './builtin.ts';
import { getSidecarManager, setSidecarManagerRef } from './sidecar-route.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';

/** A manager advertising one connected sidecar with the browser capability. */
function fakeBrowserSidecar(): SidecarManager {
  return {
    listSidecars: () => [{ id: 'remote-box', connected: true, capabilities: ['browser'] }],
  } as unknown as SidecarManager;
}

describe('#602 the main registry binds a reviewed browser call', () => {
  const original = getSidecarManager();
  afterEach(() => {
    setSidecarManagerRef(original as SidecarManager);
  });

  test('a tool that connects lazily survives review against a cold browser', () => {
    // navigate, scroll, press_key and evaluate all start with
    // ensureConnected() and need no prior snapshot, so a card raised on a cold
    // daemon must still be executable. It was not: the approval was created
    // already dead and the user's click bought "its original UI session or
    // reviewed subject is no longer available" for a call that would work.
    for (const tool of [browserNavigateTool, browserScrollTool, browserPressKeyTool, browserEvaluateTool]) {
      const guard = tool.captureApprovalGuard!({});
      expect(guard()).toBe(true);
    }
  });

  test('an element-addressed tool refuses review against a cold browser', () => {
    // click/type/hover cannot work without the snapshot that minted their ids,
    // so a cold browser at review really does mean nothing was reviewed.
    for (const tool of [browserClickTool, browserTypeTool, browserHoverTool]) {
      const guard = tool.captureApprovalGuard!({ element_id: 2 });
      expect(guard()).toBe(false);
    }
  });

  test('a call reviewed for a sidecar is not bound to the local controller', () => {
    // The local epoch says nothing about a remote browser, and on a
    // sidecar-only machine the local controller is never connected.
    const guard = browserScrollTool.captureApprovalGuard!({ target: 'remote-box', direction: 'down' });
    expect(guard()).toBe(true);
  });

  test('a call reviewed locally cannot execute remotely', () => {
    // Nothing connected at review: this is a local call.
    setSidecarManagerRef(null as unknown as SidecarManager);
    const guard = browserScrollTool.captureApprovalGuard!({ direction: 'down' });
    expect(guard()).toBe(true);

    // A browser-capable sidecar connects while the approval sits pending, so
    // `execute` would now route there. The card described the local browser,
    // and element ids do not mean the same thing on another machine, so the
    // approval must not carry over.
    setSidecarManagerRef(fakeBrowserSidecar());
    expect(guard()).toBe(false);
  });

  test('a call reviewed for a sidecar cannot execute locally', () => {
    setSidecarManagerRef(fakeBrowserSidecar());
    const guard = browserScrollTool.captureApprovalGuard!({ direction: 'down' });
    expect(guard()).toBe(true);

    // The sidecar goes away: the same call would now run on the local browser,
    // which is not what was reviewed.
    setSidecarManagerRef(null as unknown as SidecarManager);
    expect(guard()).toBe(false);
  });
});
