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
import { describe, test, expect, afterEach } from 'bun:test';
import { browser, browserClickTool, browserHoverTool, browserTypeTool, createBrowserTools } from './builtin.ts';
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
