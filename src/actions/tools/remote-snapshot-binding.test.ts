/**
 * #676 - a reviewed REMOTE browser click, type or hover is bound to the
 * snapshot it was reviewed against.
 *
 * The local path has bound the snapshot generation since #602. The remote path
 * could not, because the brain's guard is synchronous and the sidecar's
 * generation counter lives on the other machine. Now the sidecar reports
 * `elem_gen` on every page reply, the guard copies the newest one onto the
 * approval at review time, the executor runs the call inside that scope, and
 * the action carries it back for the SIDECAR to compare.
 *
 * And the fail-open is closed: an older sidecar ignores a param it has never
 * heard of, so an approved click on one is REFUSED, with a message that says it
 * is a version problem.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { DeferredExecutor } from '../../authority/deferred-executor.ts';
import { ToolRegistry } from './registry.ts';
import { browserClickTool, browserHoverTool, browserNavigateTool, browserSnapshotTool, browserTypeTool, browserScrollTool } from './builtin.ts';
import {
  getSidecarManager, remoteSnapshotGeneration, resetRemoteSnapshotGenerations, setSidecarManagerRef,
} from './sidecar-route.ts';
import { runAsReviewed } from './reviewed-call-scope.ts';
import { newSnapshotReadLog, withSnapshotReadLog } from './snapshot-read-log.ts';
import { withTemplateDeliveryScope, withoutTemplateDelivery } from './template-delivery-scope.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';
import type { SidecarInfo } from '../../sidecar/types.ts';

const box: SidecarInfo = {
  id: 'remote-box',
  name: 'Remote Box',
  enrolled_at: '2026-01-01',
  last_seen_at: '2026-01-02',
  status: 'enrolled',
  connected: true,
  hostname: 'box',
  os: 'linux',
  platform: 'x64',
  capabilities: ['browser'],
  features: ['browser_elem_gen'],
  version: '0.11.0',
  latest_version: '0.11.0',
};

type Call = { method: string; params: Record<string, unknown> };

/**
 * A sidecar whose snapshot reply carries the generation `nextGen` names at the
 * moment it is asked, and which records every RPC it receives.
 */
function fakeSidecar(info: SidecarInfo = box) {
  const calls: Call[] = [];
  const state = { nextGen: 'epoch.1' as string | null };
  const manager = {
    listSidecars: () => [info],
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'browser_snapshot' || method === 'browser_navigate') {
        return {
          text: 'Page: Bank\n[2] button "Send $5,000"',
          page_url: 'https://bank.example/confirm',
          loader_id: 'L1',
          ...(state.nextGen ? { elem_gen: state.nextGen } : {}),
        };
      }
      return `Clicked element [${String(params.element_id)}]`;
    },
  } as unknown as SidecarManager;
  return { calls, state, manager, actions: () => calls.filter((c) => c.method !== 'browser_snapshot') };
}

const original = getSidecarManager();
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  resetRemoteSnapshotGenerations();
});
afterEach(() => {
  closeDb();
  resetRemoteSnapshotGenerations();
  setSidecarManagerRef(original as SidecarManager);
});

/** Raise a card for `tool` the way the orchestrator does, and approve it. */
function approvedRequest(mgr: ApprovalManager, toolName: string, args: Record<string, unknown>, registry: ToolRegistry,
  executionMode: 'inline' | 'deferred' = 'deferred') {
  const req = mgr.createRequest({
    agentId: 'a1', agentName: 'PA', toolName, toolArguments: args, actionCategory: 'control_app',
    urgency: 'normal', reason: 'test', toolRegistry: registry, executionMode,
    context: JSON.stringify({ confirm: 'always', intent: `Review ${toolName}` }),
  });
  return req;
}

function executor(mgr: ApprovalManager, registry: ToolRegistry): DeferredExecutor {
  const ex = new DeferredExecutor(mgr, new AuditTrail());
  ex.setToolRegistry(registry);
  return ex;
}

function registryWith(...tools: Array<typeof browserClickTool>): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [browserSnapshotTool, ...tools]) if (!r.get(t.name)) r.register(t);
  return r;
}

describe('the snapshot reply records its generation (#676)', () => {
  test('under the canonical sidecar id, whatever name the call used', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    await browserSnapshotTool.execute({ target: 'Remote Box' });
    expect(remoteSnapshotGeneration('remote-box')).toBe('epoch.1');
  });

  test('a reply without one forgets the old one, because that read refilled the map', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    await browserSnapshotTool.execute({ target: 'remote-box' });
    fake.state.nextGen = null;
    await browserSnapshotTool.execute({ target: 'remote-box' });
    expect(remoteSnapshotGeneration('remote-box')).toBeNull();
  });

  test('a malformed or over-long one is not recorded', async () => {
    for (const bad of [7, ['epoch.1'], '', 'x'.repeat(65)]) {
      resetRemoteSnapshotGenerations();
      const manager = {
        listSidecars: () => [box],
        dispatchRPC: async () => ({ text: 'Page: x', page_url: 'https://x.example/', loader_id: 'L1', elem_gen: bad }),
      } as unknown as SidecarManager;
      setSidecarManagerRef(manager);
      await browserSnapshotTool.execute({ target: 'remote-box' });
      expect(remoteSnapshotGeneration('remote-box')).toBeNull();
    }
  });
});

describe('an approved remote element action carries the generation it was reviewed against (#676)', () => {
  for (const [tool, args] of [
    [browserClickTool, { element_id: 2, target: 'remote-box' }],
    [browserTypeTool, { element_id: 2, text: 'hello', target: 'remote-box' }],
    [browserHoverTool, { element_id: 2, target: 'remote-box' }],
  ] as const) {
    test(`${tool.name}: the reviewed generation, not the newest one`, async () => {
      const fake = fakeSidecar();
      setSidecarManagerRef(fake.manager);
      const registry = registryWith(tool);
      const mgr = new ApprovalManager();

      await browserSnapshotTool.execute({ target: 'remote-box' });
      const req = approvedRequest(mgr, tool.name, args, registry);
      // A second snapshot lands while the card is pending. The person reviewed
      // the FIRST one's element [2]; the brain's record now names the second.
      fake.state.nextGen = 'epoch.2';
      await browserSnapshotTool.execute({ target: 'remote-box' });
      expect(remoteSnapshotGeneration('remote-box')).toBe('epoch.2');

      mgr.approve(req.id, 'dashboard');
      const receipt = await executor(mgr, registry).executeApprovedWithReceipt(req.id);

      const sent = fake.actions();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.method).toBe(tool.name);
      expect(sent[0]!.params.elem_gen).toBe('epoch.1');
      expect(receipt.result).not.toContain('too old');
    });
  }

  test('another reader\'s snapshot does not become the generation a chat card binds', async () => {
    // Security review WEB-001: keyed by sidecar alone, a sub-agent's or a
    // workflow's snapshot between the chat model's read and its card made the
    // card bind THAT map, whose ids the model never read, and the sidecar's
    // comparison then passed. Keyed by reader, the chat card still binds the
    // chat's own snapshot, so the sidecar (now on the other map) refuses.
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    await browserSnapshotTool.execute({ target: 'remote-box' });
    fake.state.nextGen = 'epoch.2';
    await withTemplateDeliveryScope('sub-agent:helper', () => browserSnapshotTool.execute({ target: 'remote-box' }));
    fake.state.nextGen = 'epoch.3';
    await withoutTemplateDelivery(() => browserSnapshotTool.execute({ target: 'remote-box' }));
    expect(remoteSnapshotGeneration('remote-box')).toBe('epoch.1');

    const req = approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry);
    mgr.approve(req.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()[0]!.params.elem_gen).toBe('epoch.1');
  });

  test('an approved click on a sidecar too old to compare is REFUSED, and says it is a version problem', async () => {
    // The premise of #676, held: an older sidecar reads the params it knows and
    // ignores the rest, so `elem_gen` sent there would be a guard that never
    // fires. The owner's call is refusal, not acceptance.
    const fake = fakeSidecar({ ...box, features: ['update_apply'], version: '0.10.0', latest_version: '0.11.0' });
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    await browserSnapshotTool.execute({ target: 'remote-box' });
    const req = approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry);
    mgr.approve(req.id, 'dashboard');

    const receipt = await executor(mgr, registry).executeApprovedWithReceipt(req.id);

    expect(fake.actions()).toHaveLength(0);
    expect(receipt.result).toContain('too old to verify which page this browser_click was reviewed against');
    expect(receipt.result).toContain('version problem');
    expect(receipt.result).toContain('0.10.0');
    expect(receipt.result).toContain('update');
    expect(receipt.result).toContain('NOT done');
  });

  test('a sidecar that reports no features at all is too old as well', async () => {
    const fake = fakeSidecar({ ...box, features: undefined, version: undefined });
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    await browserSnapshotTool.execute({ target: 'remote-box' });
    const req = approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry);
    mgr.approve(req.id, 'dashboard');
    const receipt = await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()).toHaveLength(0);
    expect(receipt.result).toContain('too old to verify');
  });

  test('a review with no recorded generation is refused rather than sent unbound', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    // No snapshot through this process before the card was raised.
    const req = approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry);
    mgr.approve(req.id, 'dashboard');
    const receipt = await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()).toHaveLength(0);
    expect(receipt.result).toContain('cannot be verified');
    expect(receipt.result).toContain('browser_snapshot');
  });

  test('a reviewed execution whose guard bound no remote snapshot fails closed', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    await browserSnapshotTool.execute({ target: 'remote-box' });
    const out = await runAsReviewed({}, () => browserClickTool.execute({ element_id: 2, target: 'remote-box' }));
    expect(fake.actions()).toHaveLength(0);
    expect(String(out)).toContain('without a record of which browser snapshot');
  });

  test('a reviewed snapshot from another sidecar does not bind this one', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const out = await runAsReviewed({ remoteBrowserSnapshot: { sidecarId: 'other-box', elemGen: 'epoch.1' } },
      () => browserClickTool.execute({ element_id: 2, target: 'remote-box' }));
    expect(fake.actions()).toHaveLength(0);
    expect(String(out)).toContain('without a record of which browser snapshot');
  });

  test('an UNREVIEWED remote click is unchanged: no generation, and an old sidecar still works', async () => {
    // The realtime voice path auto-approves and reviews nothing, so there is
    // nothing to bind. Regression guard: passes with and without #676.
    const fake = fakeSidecar({ ...box, features: [] });
    setSidecarManagerRef(fake.manager);
    await browserSnapshotTool.execute({ target: 'remote-box' });
    const out = await browserClickTool.execute({ element_id: 2, target: 'remote-box' });
    const sent = fake.actions();
    expect(sent).toHaveLength(1);
    expect(Object.hasOwn(sent[0]!.params, 'elem_gen')).toBe(false);
    expect(String(out)).toContain('Clicked element [2]');
  });

  test('a tool that addresses no element binds no generation', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    await browserSnapshotTool.execute({ target: 'remote-box' });
    // Every remote card carries its reader (see the navigate test below); only
    // an element-addressed one carries a snapshot.
    const guard = browserScrollTool.captureApprovalGuard!({ target: 'remote-box', direction: 'down' });
    expect(guard.reviewed).toEqual({ reader: 'default' });
    expect(guard.reviewed?.remoteBrowserSnapshot).toBeUndefined();
    const click = browserClickTool.captureApprovalGuard!({ element_id: 2, target: 'remote-box' });
    expect(click.reviewed).toEqual({ remoteBrowserSnapshot: { sidecarId: 'remote-box', elemGen: 'epoch.1' }, reader: 'default' });
  });

  test('an approved navigate records its generation as the chat\'s, so a click on the page it returned works', async () => {
    // Re-review NEW-1: the executor runs with template delivery suppressed, so
    // keyed by the executor's own scope the navigate's generation landed under
    // "suppressed" and the chat's next card bound a stale or absent one.
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserNavigateTool, browserClickTool);
    const mgr = new ApprovalManager();
    await browserSnapshotTool.execute({ target: 'remote-box' });

    fake.state.nextGen = 'epoch.2';
    const nav = approvedRequest(mgr, 'browser_navigate', { url: 'https://bank.example/confirm', target: 'remote-box' }, registry);
    mgr.approve(nav.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(nav.id);
    expect(remoteSnapshotGeneration('remote-box')).toBe('epoch.2');

    const click = approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry);
    mgr.approve(click.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(click.id);
    const clicks = fake.calls.filter((c) => c.method === 'browser_click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.params.elem_gen).toBe('epoch.2');
  });
});

describe('a card binds the snapshot its own model loop read (#827)', () => {
  // #676 keyed generations by reader scope, and every main-orchestrator turn --
  // each chat channel, the voice route, every task-tier call -- is the one
  // DEFAULT reader. So a snapshot by any of them between another's read and its
  // card was what the card bound, and the sidecar's compare passed on exactly
  // the refill it exists to refuse.

  test('another default-scope snapshot between the read and the card is not what the card binds', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    const chat = newSnapshotReadLog();

    await withSnapshotReadLog(chat, () => browserSnapshotTool.execute({ target: 'remote-box' }));
    // The voice route, which runs no loop of its own: default scope, no log.
    fake.state.nextGen = 'epoch.2';
    await browserSnapshotTool.execute({ target: 'remote-box' });
    // And a turn on another channel, in its own loop.
    fake.state.nextGen = 'epoch.3';
    await withSnapshotReadLog(newSnapshotReadLog(), () => browserSnapshotTool.execute({ target: 'remote-box' }));
    // The shared record names the newest default-scope read, as before.
    expect(remoteSnapshotGeneration('remote-box')).toBe('epoch.3');

    const req = withSnapshotReadLog(chat, () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry));
    mgr.approve(req.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()[0]!.params.elem_gen).toBe('epoch.1');
  });

  test('a sub-agent started inside a chat loop does not write into that loop', async () => {
    // The sub-agent inherits the chat loop's async context. Letting its read
    // land in the chat's log would be WEB-001 again by another route.
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    const chat = newSnapshotReadLog();

    await withSnapshotReadLog(chat, async () => {
      await browserSnapshotTool.execute({ target: 'remote-box' });
      fake.state.nextGen = 'epoch.2';
      await withTemplateDeliveryScope('sub-agent:helper', () => browserSnapshotTool.execute({ target: 'remote-box' }));
      fake.state.nextGen = 'epoch.3';
      await withoutTemplateDelivery(() => browserSnapshotTool.execute({ target: 'remote-box' }));
    });
    expect(chat.generations.get('remote-box')).toBe('epoch.1');

    const req = withSnapshotReadLog(chat, () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry));
    mgr.approve(req.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()[0]!.params.elem_gen).toBe('epoch.1');
  });

  test('an INLINE approved navigate records into the loop that raised it, so the next click there works', async () => {
    // NEW-1 (#676) for the loop record: the executor runs outside the loop's
    // async context, so without carrying the loop on the approval the
    // navigate's generation would miss the loop and its next card would bind
    // the pre-navigate read. Inline only: the loop's gate is waiting for it.
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserNavigateTool, browserClickTool);
    const mgr = new ApprovalManager();
    const chat = newSnapshotReadLog();
    await withSnapshotReadLog(chat, () => browserSnapshotTool.execute({ target: 'remote-box' }));

    fake.state.nextGen = 'epoch.2';
    const nav = withSnapshotReadLog(chat, () =>
      approvedRequest(mgr, 'browser_navigate', { url: 'https://bank.example/confirm', target: 'remote-box' }, registry, 'inline'));
    mgr.approve(nav.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(nav.id);
    expect(chat.generations.get('remote-box')).toBe('epoch.2');

    const click = withSnapshotReadLog(chat, () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry));
    mgr.approve(click.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(click.id);
    const clicks = fake.calls.filter((c) => c.method === 'browser_click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.params.elem_gen).toBe('epoch.2');
  });

  test('a navigate approved late, after its inline wait was demoted, does not write the still-running loop', async () => {
    // Security review SEC-002: the loop got [AWAITING_APPROVAL] and carried on
    // with the page it had read. A navigate approved minutes later went to a
    // person's notification, not to that loop's model -- so letting it write
    // the loop's record made the loop's next card bind a page it never read.
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserNavigateTool, browserClickTool);
    const mgr = new ApprovalManager();
    const chat = newSnapshotReadLog();
    await withSnapshotReadLog(chat, () => browserSnapshotTool.execute({ target: 'remote-box' }));

    const nav = withSnapshotReadLog(chat, () =>
      approvedRequest(mgr, 'browser_navigate', { url: 'https://bank.example/next', target: 'remote-box' }, registry, 'inline'));
    expect(mgr.demoteToDeferred(nav.id)).toBe(true);
    fake.state.nextGen = 'epoch.2';
    mgr.approve(nav.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(nav.id);
    expect(chat.generations.get('remote-box')).toBe('epoch.1');

    const click = withSnapshotReadLog(chat, () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry, 'inline'));
    mgr.approve(click.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(click.id);
    // Bound to what the loop read; the sidecar, now on epoch.2, refuses it.
    expect(fake.calls.filter((c) => c.method === 'browser_click')[0]!.params.elem_gen).toBe('epoch.1');
  });

  test('a resumed loop replaying snapshot replies binds nothing rather than another reader\'s read', async () => {
    // Security review SEC-003: a paused task replays its snapshot replies but
    // not their generations. Falling back to the shared record bound whatever
    // another reader snapshotted during the pause.
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    fake.state.nextGen = 'epoch.9';
    await browserSnapshotTool.execute({ target: 'remote-box' });
    expect(remoteSnapshotGeneration('remote-box')).toBe('epoch.9');

    const resumed = newSnapshotReadLog({ resumedWithReads: true });
    const req = withSnapshotReadLog(resumed, () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry, 'inline'));
    mgr.approve(req.id, 'dashboard');
    const receipt = await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()).toHaveLength(0);
    expect(receipt.result).toContain('cannot be verified');

    // Once the resumed loop snapshots again, its own read binds as usual.
    fake.state.nextGen = 'epoch.10';
    await withSnapshotReadLog(resumed, () => browserSnapshotTool.execute({ target: 'remote-box' }));
    const again = withSnapshotReadLog(resumed, () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry, 'inline'));
    mgr.approve(again.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(again.id);
    expect(fake.actions()[0]!.params.elem_gen).toBe('epoch.10');
  });

  test('a loop whose own read carried no generation does not borrow another reader\'s', async () => {
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    const chat = newSnapshotReadLog();

    fake.state.nextGen = null;
    await withSnapshotReadLog(chat, () => browserSnapshotTool.execute({ target: 'remote-box' }));
    fake.state.nextGen = 'epoch.2';
    await browserSnapshotTool.execute({ target: 'remote-box' });
    expect(remoteSnapshotGeneration('remote-box')).toBe('epoch.2');

    const req = withSnapshotReadLog(chat, () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry));
    mgr.approve(req.id, 'dashboard');
    const receipt = await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()).toHaveLength(0);
    expect(receipt.result).toContain('cannot be verified');
  });

  test('THE RESIDUAL: a loop that read nothing itself still binds the shared default record', async () => {
    // Stated, not fixed: ids the model carried over in its own text from an
    // earlier turn have no read in this loop, and fall back to what #676 did.
    // A regression guard that passes with and without #827.
    const fake = fakeSidecar();
    setSidecarManagerRef(fake.manager);
    const registry = registryWith(browserClickTool);
    const mgr = new ApprovalManager();
    await withSnapshotReadLog(newSnapshotReadLog(), () => browserSnapshotTool.execute({ target: 'remote-box' }));
    const req = withSnapshotReadLog(newSnapshotReadLog(), () =>
      approvedRequest(mgr, 'browser_click', { element_id: 2, target: 'remote-box' }, registry));
    mgr.approve(req.id, 'dashboard');
    await executor(mgr, registry).executeApprovedWithReceipt(req.id);
    expect(fake.actions()[0]!.params.elem_gen).toBe('epoch.1');
  });
});
