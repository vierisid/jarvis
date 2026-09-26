import { test, expect, describe } from 'bun:test';
import { createBrowserTools, NON_BROWSER_TOOLS, BUILTIN_TOOLS } from '../actions/tools/builtin.ts';
import { BrowserController } from '../actions/browser/session.ts';

describe('NON_BROWSER_TOOLS', () => {
  test('contains 9 non-browser tools', () => {
    expect(NON_BROWSER_TOOLS).toHaveLength(9);
    const names = NON_BROWSER_TOOLS.map(t => t.name);
    expect(names).toContain('run_command');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_directory');
    expect(names).toContain('list_sidecars');
    expect(names).toContain('get_clipboard');
    expect(names).toContain('set_clipboard');
    expect(names).toContain('capture_screen');
    expect(names).toContain('get_system_info');
  });

  test('none have browser category', () => {
    for (const tool of NON_BROWSER_TOOLS) {
      expect(tool.category).not.toBe('browser');
    }
  });
});

describe('createBrowserTools', () => {
  test('returns 9 browser tools', () => {
    const ctrl = new BrowserController(9999);
    const tools = createBrowserTools(ctrl);
    expect(tools).toHaveLength(9);
  });

  test('all tools have browser category', () => {
    const ctrl = new BrowserController(9999);
    const tools = createBrowserTools(ctrl);
    for (const tool of tools) {
      expect(tool.category).toBe('browser');
    }
  });

  test('tool names match expected browser tools', () => {
    const ctrl = new BrowserController(9999);
    const tools = createBrowserTools(ctrl);
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'browser_click',
      'browser_evaluate',
      'browser_hover',
      'browser_navigate',
      'browser_press_key',
      'browser_screenshot',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
    ]);
  });

  test('BUILTIN_TOOLS = NON_BROWSER_TOOLS + 10 browser + 9 desktop + 2 ui + 3 skill tools', () => {
    expect(BUILTIN_TOOLS).toHaveLength(NON_BROWSER_TOOLS.length + 10 + 9 + 2 + 3);
  });
});

describe('BrowserController parameterization', () => {
  test('approval guards reject a disconnected or replaced CDP session', async () => {
    let peer: { close(): void } | undefined;
    let browserPeer: { close(): void } | undefined;
    const server = Bun.serve<{ path: string }>({
      port: 0,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        // /browser is the browser-level socket the request guard (#521)
        // attaches to before the page; only the page socket is `peer`.
        if (path === '/page' || path === '/browser') {
          if (server.upgrade(req, { data: { path } })) return;
          return new Response('upgrade failed', { status: 400 });
        }
        if (path === '/json/version') {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/browser` });
        }
        return Response.json(path === '/json/list'
          ? [{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/page` }]
          : {});
      },
      websocket: {
        open(ws) {
          if (ws.data.path === '/page') peer = ws;
          else browserPeer = ws;
        },
        message(ws, message) {
          const request = JSON.parse(String(message));
          ws.send(JSON.stringify({ id: request.id, result: {} }));
        },
      },
    });
    const ctrl = new BrowserController(server.port!);
    try {
      const initialNavigation = ctrl.captureApprovalGuard(true);
      expect(initialNavigation()).toBe(true);
      expect(ctrl.captureApprovalGuard()()).toBe(false);
      await ctrl.connect();
      expect(initialNavigation()).toBe(false);
      const original = ctrl.captureApprovalGuard();
      expect(original()).toBe(true);
      await ctrl.disconnect();
      expect(original()).toBe(false);
      await ctrl.connect();
      expect(original()).toBe(false);
      const replacement = ctrl.captureApprovalGuard();
      expect(replacement()).toBe(true);
      peer!.close();
      for (let i = 0; i < 100 && replacement(); i++) await Bun.sleep(5);
      expect(replacement()).toBe(false);
      await ctrl.disconnect();
      // Losing the request guard's socket ends Chrome's interception, so it
      // invalidates an approval exactly like losing the page socket.
      await ctrl.connect();
      const guarded = ctrl.captureApprovalGuard();
      expect(guarded()).toBe(true);
      browserPeer!.close();
      for (let i = 0; i < 100 && guarded(); i++) await Bun.sleep(5);
      expect(guarded()).toBe(false);
      await ctrl.disconnect();
      const lazy = ctrl.captureApprovalGuard(true);
      await ctrl.disconnect();
      expect(lazy()).toBe(false);
    } finally {
      await ctrl.disconnect();
      server.stop(true);
    }
  });

  test('accepts custom port', () => {
    const ctrl = new BrowserController(9223);
    // Should not throw — port is stored internally
    expect(ctrl).toBeDefined();
  });

  test('accepts custom port and profile dir', () => {
    const ctrl = new BrowserController(9223, '/tmp/test-bg-profile');
    expect(ctrl).toBeDefined();
  });

  test('defaults work (no args)', () => {
    const ctrl = new BrowserController();
    expect(ctrl).toBeDefined();
  });
});
