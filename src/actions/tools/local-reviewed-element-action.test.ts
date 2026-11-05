/**
 * #875, end to end through the tool layer: a LOCAL click, hover or type card
 * carries the element-map generation it was reviewed against, and the approved
 * call is held to it under the controller's snapshot lock.
 *
 * The session-level tests (actions/browser/snapshot-serialisation.test.ts) prove
 * the controller refuses a stale `reviewedGen`; this proves the generation gets
 * there -- captured by `browserCallGuard` at review, carried by the approval
 * executor's reviewed scope, read by the tool's `execute`. Drives the
 * module-level `browser`, the controller the chat and every sub-agent share.
 */
import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { browser, browserClickTool, browserHoverTool, browserNavigateTool, browserSnapshotTool, browserTypeTool, createBrowserTools } from './builtin.ts';
import { newSnapshotReadLog, withSnapshotReadLog } from './snapshot-read-log.ts';
import { ToolRegistry } from './registry.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { DeferredExecutor } from '../../authority/deferred-executor.ts';
import { runAsReviewed, type ReviewedExecution } from './reviewed-call-scope.ts';
import { FakeRenderer, controllerOver, snapshotInFlight, wireController } from '../browser/fixtures/fake-renderer.ts';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const SUPERSEDED = 'reviewed against a browser snapshot that has since been replaced';

describe('#875: an approved local element action is held to the snapshot it was reviewed against', () => {
  test('the guard binds the local generation and the approved type refuses a newer snapshot', async () => {
    const to = { name: 'To', x: 50, y: 40 };
    const search = { name: 'Search', x: 50, y: 400 };
    const fake = new FakeRenderer([to]);
    restore = wireController(browser, fake);

    await browser.snapshot();
    const params = { element_id: 1, text: 'approved text' };
    const guard = browserTypeTool.captureApprovalGuard!(params) as (() => boolean) & { reviewed?: ReviewedExecution };
    expect(guard.reviewed).toEqual({ localSnapshotGen: browser.snapshotGeneration() });

    fake.dom = [search, to];
    const { done } = await snapshotInFlight(fake, browser);
    // What the approval executor does: check the guard, then run the call in
    // the scope the guard bound.
    expect(guard()).toBe(true);
    const typing = runAsReviewed(guard.reviewed, () => browserTypeTool.execute(params));
    fake.resume();
    const result = await typing;
    await done;

    expect(fake.typed).toEqual([]);
    expect(String(result)).toContain(SUPERSEDED);
  });

  test('the approved click and hover carry it too', async () => {
    const buy = { name: 'Buy', x: 50, y: 40 };
    const del = { name: 'Delete account', x: 50, y: 40 };
    const fake = new FakeRenderer([buy]);
    restore = wireController(browser, fake);

    await browser.snapshot();
    const clickGuard = browserClickTool.captureApprovalGuard!({ element_id: 1 }) as (() => boolean) & { reviewed?: ReviewedExecution };
    const hoverGuard = browserHoverTool.captureApprovalGuard!({ element_id: 1 }) as (() => boolean) & { reviewed?: ReviewedExecution };

    buy.y = 300;
    fake.dom = [del, buy];
    const { done } = await snapshotInFlight(fake, browser);
    expect(clickGuard()).toBe(true);
    expect(hoverGuard()).toBe(true);
    const clicking = runAsReviewed(clickGuard.reviewed, () => browserClickTool.execute({ element_id: 1 }));
    const hovering = runAsReviewed(hoverGuard.reviewed, () => browserHoverTool.execute({ element_id: 1 }));
    fake.resume();
    const [clicked, hovered] = await Promise.all([clicking, hovering]);
    await done;

    expect(fake.log.filter((l) => l === 'Input.dispatchMouseEvent')).toEqual([]);
    expect(String(clicked)).toContain(SUPERSEDED);
    expect(String(hovered)).toContain(SUPERSEDED);
  });

  test('an approved type with nothing in between still types into the reviewed element', async () => {
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    restore = wireController(browser, fake);
    await browser.snapshot();
    const params = { element_id: 1, text: 'approved text' };
    const guard = browserTypeTool.captureApprovalGuard!(params) as (() => boolean) & { reviewed?: ReviewedExecution };

    expect(guard()).toBe(true);
    const result = await runAsReviewed(guard.reviewed, () => browserTypeTool.execute(params));

    expect(String(result)).toBe('Typed "approved text" into element [1]');
    expect(fake.typed).toEqual([{ text: 'approved text', into: 'To' }]);
  });

  test('an approved call with no local generation bound is refused, not run as ungated', async () => {
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    restore = wireController(browser, fake);
    await browser.snapshot();

    // An approved scope (the executor always enters one) from a guard that
    // bound nothing.
    const typed = await runAsReviewed({}, () => browserTypeTool.execute({ element_id: 1, text: 'approved text' }));
    const clicked = await runAsReviewed({}, () => browserClickTool.execute({ element_id: 1 }));
    const hovered = await runAsReviewed({}, () => browserHoverTool.execute({ element_id: 1 }));

    for (const result of [typed, clicked, hovered]) expect(String(result)).toContain('carries no record of the snapshot');
    expect(fake.typed).toEqual([]);
    expect(fake.log.filter((l) => l === 'Input.dispatchMouseEvent')).toEqual([]);
  });

  test('the background agent\'s registry binds and enforces the generation too', async () => {
    const to = { name: 'To', x: 50, y: 40 };
    const search = { name: 'Search', x: 50, y: 400 };
    const fake = new FakeRenderer([to]);
    const ctrl = controllerOver(fake);
    const tools = createBrowserTools(ctrl);
    const type = tools.find((t) => t.name === 'browser_type')!;
    const click = tools.find((t) => t.name === 'browser_click')!;
    const hover = tools.find((t) => t.name === 'browser_hover')!;

    await ctrl.snapshot();
    const params = { element_id: 1, text: 'approved text' };
    const guards = [type, click, hover].map((t) =>
      t.captureApprovalGuard!(params) as (() => boolean) & { reviewed?: ReviewedExecution });
    for (const g of guards) expect(g.reviewed).toEqual({ localSnapshotGen: ctrl.snapshotGeneration() });

    fake.dom = [search, to];
    const { done } = await snapshotInFlight(fake, ctrl);
    for (const g of guards) expect(g()).toBe(true);
    const runs = [type, click, hover].map((t, i) => runAsReviewed(guards[i]!.reviewed, () => t.execute(params)));
    fake.resume();
    const results = await Promise.all(runs);
    await done;

    for (const r of results) expect(String(r)).toContain(SUPERSEDED);
    expect(fake.typed).toEqual([]);
    expect(fake.log.filter((l) => l === 'Input.dispatchMouseEvent')).toEqual([]);
  });
});

/**
 * #1161: the local half of #827. The controller is one object every caller
 * shares, so its current generation is whatever ANY of them snapshotted last.
 * A card bound to that bound another reader's map; a loop's card now binds the
 * loop's own newest local read.
 */
describe('#1161: a local card binds the snapshot its own loop read', () => {
  // The tools resolve a site playbook for the page they read.
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());
  type Guard = (() => boolean) & { reviewed?: ReviewedExecution };

  test('another caller\'s snapshot between the loop\'s read and its card is not what the card binds', async () => {
    const buy = { name: 'Buy', x: 50, y: 40 };
    const del = { name: 'Delete account', x: 50, y: 40 };
    const fake = new FakeRenderer([buy]);
    restore = wireController(browser, fake);
    const chat = newSnapshotReadLog();

    await withSnapshotReadLog(chat, () => browserSnapshotTool.execute({}));
    const chatGen = browser.snapshotGeneration();
    expect(chat.localGeneration).toBe(chatGen);

    // Another caller (the voice route, a task-tier call, another channel's
    // loop) re-reads the page after it changed: [1] is now Delete account.
    buy.y = 300;
    fake.dom = [del, buy];
    await withSnapshotReadLog(newSnapshotReadLog(), () => browserSnapshotTool.execute({}));
    expect(browser.snapshotGeneration()).toBe(chatGen + 1);

    // The chat model raises a card for [1] -- Buy, in what it read. The card
    // must not name the other reader's [1].
    const subject = withSnapshotReadLog(chat, () => browserClickTool.reviewSubject!({ element_id: 1 })) as { element?: string };
    expect(subject.element).toBe('element [1]');
    const guard = withSnapshotReadLog(chat, () => browserClickTool.captureApprovalGuard!({ element_id: 1 })) as Guard;
    expect(guard.reviewed?.localSnapshotGen).toBe(chatGen);
    expect(guard()).toBe(true);
    const clicked = await runAsReviewed(guard.reviewed ?? {}, () => browserClickTool.execute({ element_id: 1 }));

    // Before #1161 the card bound the newest map and this pressed Delete account.
    expect(fake.clicks).toEqual([]);
    expect(String(clicked)).toContain(SUPERSEDED);
  });

  test('a card in a loop with no local read of its own still binds the current map (the residual)', async () => {
    const fake = new FakeRenderer([{ name: 'Buy', x: 50, y: 40 }]);
    restore = wireController(browser, fake);
    await browserSnapshotTool.execute({});
    const guard = withSnapshotReadLog(newSnapshotReadLog(), () => browserClickTool.captureApprovalGuard!({ element_id: 1 })) as Guard;
    expect(guard.reviewed?.localSnapshotGen).toBe(browser.snapshotGeneration());
    const subject = withSnapshotReadLog(newSnapshotReadLog(), () => browserClickTool.reviewSubject!({ element_id: 1 })) as { element?: string };
    expect(subject.element).toContain('Buy');
    const clicked = await runAsReviewed(guard.reviewed ?? {}, () => browserClickTool.execute({ element_id: 1 }));
    expect(String(clicked)).toContain('Clicked element [1]');
  });

  test('a resumed loop replaying snapshot replies binds nothing, and the approved click is refused', async () => {
    const fake = new FakeRenderer([{ name: 'Buy', x: 50, y: 40 }]);
    restore = wireController(browser, fake);
    await browserSnapshotTool.execute({});
    const resumed = newSnapshotReadLog({ resumedWithReads: true });

    const guard = withSnapshotReadLog(resumed, () => browserClickTool.captureApprovalGuard!({ element_id: 1 })) as Guard;
    expect(guard.reviewed?.localSnapshotGen).toBeUndefined();
    const clicked = await runAsReviewed(guard.reviewed ?? {}, () => browserClickTool.execute({ element_id: 1 }));
    expect(fake.clicks).toEqual([]);
    expect(String(clicked)).toContain('carries no record of the snapshot');

    // Once it snapshots again, its own read binds as usual.
    await withSnapshotReadLog(resumed, () => browserSnapshotTool.execute({}));
    const again = withSnapshotReadLog(resumed, () => browserClickTool.captureApprovalGuard!({ element_id: 1 })) as Guard;
    expect(again.reviewed?.localSnapshotGen).toBe(browser.snapshotGeneration());
  });

  test('an approved local navigate records into the loop that raised it, so its next card binds the new page', async () => {
    const fake = new FakeRenderer([{ name: 'Next', x: 50, y: 40 }]);
    restore = wireController(browser, fake);
    const chat = newSnapshotReadLog();
    await withSnapshotReadLog(chat, () => browserSnapshotTool.execute({}));
    const before = chat.localGeneration;

    const nav = withSnapshotReadLog(chat, () => browserNavigateTool.captureApprovalGuard!({ url: 'https://mail.example.test/next' })) as Guard;
    // The executor runs it outside the loop, in the scope the guard bound.
    const result = await runAsReviewed(nav.reviewed ?? {}, () => browserNavigateTool.execute({ url: 'https://mail.example.test/next' }));
    expect(String(result)).toContain('Page: Mail');
    expect(chat.localGeneration).toBe(browser.snapshotGeneration());
    expect(chat.localGeneration).not.toBe(before);
  });
  test('a DEFERRED approved local navigate does not write the loop that raised it', async () => {
    // Its result goes to a person, not to that loop's model (#827 SEC-002):
    // `getUiExecution` detaches the log for any mode but inline.
    const fake = new FakeRenderer([{ name: 'Next', x: 50, y: 40 }]);
    restore = wireController(browser, fake);
    const chat = newSnapshotReadLog();
    await withSnapshotReadLog(chat, () => browserSnapshotTool.execute({}));
    const before = chat.localGeneration;

    const registry = new ToolRegistry();
    registry.register(browserSnapshotTool);
    registry.register(browserNavigateTool);
    const mgr = new ApprovalManager();
    const req = withSnapshotReadLog(chat, () => mgr.createRequest({
      agentId: 'a1', agentName: 'PA', toolName: 'browser_navigate', toolArguments: { url: 'https://mail.example.test/next' },
      actionCategory: 'control_app', urgency: 'normal', reason: 'test', toolRegistry: registry, executionMode: 'deferred',
      context: JSON.stringify({ confirm: 'always', intent: 'Review browser_navigate' }),
    }));
    mgr.approve(req.id, 'dashboard');
    const ex = new DeferredExecutor(mgr, new AuditTrail());
    ex.setToolRegistry(registry);
    await ex.executeApprovedWithReceipt(req.id);

    expect(browser.snapshotGeneration()).not.toBe(before);
    expect(chat.localGeneration).toBe(before);
  });
});
