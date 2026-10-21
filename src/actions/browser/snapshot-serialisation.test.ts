/**
 * #875 -- the local browser's half of #826: a snapshot ARMS the isolated
 * world's element refs when its script runs in the renderer, and fills the
 * coordinate map and bumps `snapshotGen` one CDP round trip later. Between the
 * two, the world holds the new reading's refs while the generation still names
 * the old one.
 *
 * The controller is one process-global object (`browser` in
 * actions/tools/builtin.ts) that the chat and every sub-agent drive, so a
 * sub-agent's snapshot can be in that window while an approved chat action
 * runs. These tests force exactly that interleaving with a scripted renderer
 * that answers in FIFO order, as a single CDP session does, and pause it
 * between a snapshot's evaluate and its re-read of the frame tree.
 *
 * Not a race detector's job: every access here is single-threaded JS, so there
 * is no data race to find. The defect is ordering, and only a forced ordering
 * shows it (the same lesson as #826's Go test, where -race reported nothing).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { setSnapshotLockTimeoutForTests, type BrowserController } from './session.ts';
import { collectActionVerification } from '../action-verification.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import { FakeRenderer, controllerOver, snapshotInFlight } from './fixtures/fake-renderer.ts';

afterEach(() => setSnapshotLockTimeoutForTests(null));

/**
 * The typed outcome an action reports, as the approval executor sees it: run
 * inside a UI verification scope, where a refusal THROWS with its effect
 * rather than returning text.
 */
async function effectOf(run: () => Promise<string>): Promise<string> {
  try {
    await collectActionVerification('browser_click', 'browser', run);
    return 'succeeded';
  } catch (err) {
    if (err instanceof ActionOutcomeError) return err.outcome.effect;
    throw err;
  }
}

const bumpEpoch = (browser: BrowserController) => {
  (browser as unknown as { approvalEpoch: number }).approvalEpoch++;
};

describe('#875: a snapshot in flight cannot re-arm the refs under a reviewed action', () => {
  test('an approved type reviewed against one snapshot does not type into the next one\'s element', async () => {
    const to = { name: 'To', x: 50, y: 40 };
    const search = { name: 'Search', x: 50, y: 400 };
    const fake = new FakeRenderer([to]);
    const browser = controllerOver(fake);

    // The chat snapshots; the person reviews `browser_type [1] "approved text"`
    // against it: element [1] is the To field.
    await browser.snapshot();
    const guard = browser.captureApprovalGuard(false, { bindDocument: true });
    const reviewedGen = browser.snapshotGeneration();

    // The page re-renders, and a sub-agent sharing this controller snapshots:
    // its script has armed the world -- [1] is now the search box -- and its
    // fill has not run yet.
    fake.dom = [search, to];
    const { done: second } = await snapshotInFlight(fake, browser);
    expect(fake.world?.elements[0]).toBe(search);

    // The approval executor checks the guard, then dispatches. The guard
    // PASSES here: the generation has not moved yet. That is #826's point.
    expect(guard()).toBe(true);
    const typing = browser.type(1, 'approved text', false, false, { reviewedGen });
    fake.resume();
    const result = await typing;
    await second;

    // Nothing may reach the search box. Before #875 the text went there and
    // type() reported success.
    expect(fake.typed.filter((t) => t.into === 'Search')).toEqual([]);
    expect(result).not.toContain('Typed "approved text"');
    expect(result).toContain('reviewed against a browser snapshot that has since been replaced');
    expect(fake.typed).toEqual([]);
  });

  test('an approved click is held to the snapshot it was reviewed against, not the sentinel of the next', async () => {
    const buy = { name: 'Buy', x: 50, y: 40 };
    const del = { name: 'Delete account', x: 50, y: 40 };
    const fake = new FakeRenderer([buy]);
    const browser = controllerOver(fake);

    await browser.snapshot();
    const guard = browser.captureApprovalGuard(false, { bindDocument: true });
    const reviewedGen = browser.snapshotGeneration();

    // Buy moves down and Delete takes its place; a second snapshot arms the
    // world on that layout. Read against the REVIEWED refs the sentinel would
    // say Buy moved and refuse; read against the new refs it says 'ok'.
    buy.y = 300;
    fake.dom = [del, buy];
    const { done: second } = await snapshotInFlight(fake, browser);

    expect(guard()).toBe(true);
    const clicking = browser.click(1, {}, { reviewedGen });
    fake.resume();
    const result = await clicking;
    await second;

    // Before #875 this pressed at (50, 40) -- on Delete account -- and
    // reported "Clicked element [1]".
    expect(fake.clicks).toEqual([]);
    expect(result).not.toContain('Clicked element [1]');
    expect(result).toContain('reviewed against a browser snapshot that has since been replaced');
  });

  test('an approved hover is held to the snapshot it was reviewed against too', async () => {
    const menu = { name: 'Menu', x: 50, y: 40 };
    const other = { name: 'Other', x: 50, y: 40 };
    const fake = new FakeRenderer([menu]);
    const browser = controllerOver(fake);

    await browser.snapshot();
    const reviewedGen = browser.snapshotGeneration();
    menu.y = 300;
    fake.dom = [other, menu];
    const { done: second } = await snapshotInFlight(fake, browser);

    const hovering = browser.hover(1, { reviewedGen });
    fake.resume();
    const result = await hovering;
    await second;

    expect(result).toContain('reviewed against a browser snapshot that has since been replaced');
    expect(fake.log.filter((l) => l === 'Input.dispatchMouseEvent')).toEqual([]);
  });

  test('a type held to its own snapshot still types when nothing replaced it', async () => {
    // The control for the tests above: the same reviewed generation, no second
    // snapshot, and the text lands in the reviewed element. Without this the
    // refusals above could come from a type() that refuses everything.
    const to = { name: 'To', x: 50, y: 40 };
    const fake = new FakeRenderer([to]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    const reviewedGen = browser.snapshotGeneration();

    const result = await browser.type(1, 'approved text', false, false, { reviewedGen });

    expect(result).toBe('Typed "approved text" into element [1]');
    expect(fake.typed).toEqual([{ text: 'approved text', into: 'To' }]);
  });

  test('two snapshots at once run one after the other', async () => {
    const fake = new FakeRenderer([{ name: 'A', x: 1, y: 1 }]);
    const browser = controllerOver(fake);
    const gen0 = browser.snapshotGeneration();
    await Promise.all([browser.snapshot(), browser.snapshot()]);
    // Each snapshot's script and its fill-gating frame-tree read are adjacent:
    // no second script runs in between.
    const order = fake.log.filter((l) => l === 'evaluate:snapshot' || l === 'Page.getFrameTree');
    expect(order).toEqual([
      'Page.getFrameTree', 'evaluate:snapshot', 'Page.getFrameTree',
      'Page.getFrameTree', 'evaluate:snapshot', 'Page.getFrameTree',
    ]);
    expect(browser.snapshotGeneration()).toBe(gen0 + 2);
  });

  test('a snapshot that fails releases the lock', async () => {
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    const original = fake.send.bind(fake);
    let fail = true;
    (fake as unknown as { send: typeof original }).send = (method, params) => {
      if (fail && method === 'Runtime.evaluate' && String(params?.expression).includes('__jarvis_elements = els.map')) {
        fail = false;
        return Promise.resolve({ exceptionDetails: { text: 'boom' } });
      }
      return original(method, params);
    };
    await expect(browser.snapshot()).rejects.toThrow('Snapshot failed');
    await browser.snapshot();
    expect(await browser.type(1, 'x')).toBe('Typed "x" into element [1]');
  });

  test('a renderer that never answers a snapshot makes a later type refuse, not wait forever', async () => {
    setSnapshotLockTimeoutForTests(50);
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    fake.hangSnapshots = true;
    void browser.snapshot();
    const result = await browser.type(1, 'x');
    expect(result).toContain('another browser snapshot or typed input is still running');
    expect(fake.typed).toEqual([]);
  });

  test('a waiter that timed out leaves the lock usable once the holder lets go', async () => {
    // The timeout must take its waiter OUT of the queue: otherwise the
    // holder's release would hand the lock to a waiter that already gave up,
    // and every later snapshot and element action would wait out the timeout.
    setSnapshotLockTimeoutForTests(30);
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();

    const { done } = await snapshotInFlight(fake, browser);
    const refused = await browser.type(1, 'x');
    expect(refused).toContain('another browser snapshot or typed input is still running');
    fake.resume();
    await done;

    setSnapshotLockTimeoutForTests(5_000);
    const started = Date.now();
    expect(await browser.type(1, 'y')).toBe('Typed "y" into element [1]');
    // The type's own settle is 200ms; a lock stuck on the dead waiter would
    // cost the full 5 seconds and then refuse.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a type with submit presses Enter only while the reviewed element still has focus', async () => {
    // The Enter goes to whatever holds focus. A page (or another caller) that
    // moves focus after the text is in must not get the approved submit.
    const to = { name: 'To', x: 50, y: 40 };
    const search = { name: 'Search', x: 50, y: 400 };
    const fake = new FakeRenderer([to, search]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    // After the post-insert focus verify, inside the pre-Enter settle.
    fake.afterInsert = () => { setTimeout(() => { fake.focused = search; }, 40); };

    const result = await browser.type(1, 'approved text', true);

    expect(fake.typed).toEqual([{ text: 'approved text', into: 'To' }]);
    expect(fake.keys).toEqual([]);
    expect(result).toContain('so Enter was not pressed');
  });

  test('a type with submit still submits when focus held', async () => {
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    const result = await browser.type(1, 'hello', true);
    expect(result).toBe('Typed "hello" into element [1] and pressed Enter');
    expect(fake.keys).toEqual(['Enter->To']);
  }, 10_000);

  test('a type whose connection is re-established mid-action types nothing more', async () => {
    // A stale-connection reconnect runs in ensureConnected, outside the lock
    // (a snapshot's caller, say), and may adopt another tab: the context id
    // this type holds then names nothing reviewed.
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    fake.afterFocus = () => { (browser as unknown as { approvalEpoch: number }).approvalEpoch++; };

    const result = await browser.type(1, 'approved text');

    expect(fake.typed).toEqual([]);
    expect(result).toContain('connection was re-established');
  });

  test('a click holds the lock through its press, so another element action cannot run in between', async () => {
    const fake = new FakeRenderer([{ name: 'Buy', x: 50, y: 40 }, { name: 'To', x: 50, y: 400 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();

    await Promise.all([browser.click(1), browser.type(2, 'x')]);

    const lastMouse = fake.log.lastIndexOf('Input.dispatchMouseEvent');
    const focus = fake.log.indexOf('evaluate:focus');
    expect(lastMouse).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(lastMouse);
    // And the type's own check ran after the press, not before it.
    const typeCheck = fake.log.indexOf('evaluate:sentinel', fake.log.indexOf('evaluate:sentinel') + 1);
    expect(typeCheck).toBeGreaterThan(lastMouse);
  });

  test('a click whose connection is re-established before its press presses nothing', async () => {
    const fake = new FakeRenderer([{ name: 'Buy', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    fake.afterAnswer = (l) => {
      if (l === 'evaluate:sentinel') (browser as unknown as { approvalEpoch: number }).approvalEpoch++;
    };

    const result = await browser.click(1);

    expect(fake.clicks).toEqual([]);
    expect(fake.log.filter((l) => l === 'Input.dispatchMouseEvent')).toEqual([]);
    expect(result).toContain('connection was re-established');

    // Nothing went out, so it is safe to say nothing happened.
    let n = 0;
    fake.afterAnswer = (l) => { if (l === 'evaluate:sentinel' && n++ === 0) bumpEpoch(browser); };
    expect(await effectOf(() => browser.click(1))).toBe('not_started');
  });

  test('a click whose connection is re-established between its events sends no more of them', async () => {
    const fake = new FakeRenderer([{ name: 'Buy', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    // After the pointer move, before the press.
    fake.afterAnswer = (l) => {
      if (l === 'Input.dispatchMouseEvent') (browser as unknown as { approvalEpoch: number }).approvalEpoch++;
    };

    const result = await browser.click(1);

    expect(fake.log.filter((l) => l === 'Input.dispatchMouseEvent')).toHaveLength(1);
    expect(fake.clicks).toEqual([]);
    expect(result).toContain('connection was re-established');

    // The pointer moved, which a hover-sensitive page reacts to.
    let n = 0;
    fake.afterAnswer = (l) => { if (l === 'Input.dispatchMouseEvent' && n++ === 0) bumpEpoch(browser); };
    expect(await effectOf(() => browser.click(1))).toBe('may_have_occurred');
  });

  test('a submit whose connection is re-established mid-Enter sends no more key events', async () => {
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    fake.afterAnswer = (l) => {
      if (l === 'Input.dispatchKeyEvent') (browser as unknown as { approvalEpoch: number }).approvalEpoch++;
    };

    const result = await browser.type(1, 'hello', true);

    expect(fake.typed).toEqual([{ text: 'hello', into: 'To' }]);
    expect(fake.log.filter((l) => l === 'Input.dispatchKeyEvent')).toHaveLength(1);
    expect(result).toContain('may or may not have been submitted');
  });

  test('a submit whose connection is re-established after the char event sends no keyUp', async () => {
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    let keys = 0;
    fake.afterAnswer = (l) => { if (l === 'Input.dispatchKeyEvent' && ++keys === 2) bumpEpoch(browser); };

    const result = await browser.type(1, 'hello', true);

    expect(fake.log.filter((l) => l === 'Input.dispatchKeyEvent')).toHaveLength(2);
    expect(result).toContain('may or may not have been submitted');
  });

  test('a reconnect during the pre-Enter focus check says Enter was not pressed', async () => {
    const fake = new FakeRenderer([{ name: 'To', x: 50, y: 40 }]);
    const browser = controllerOver(fake);
    await browser.snapshot();
    // The focus verifies are: before the insert, after it, and before Enter.
    let verifies = 0;
    fake.afterAnswer = (l) => { if (l === 'evaluate:other' && ++verifies === 3) bumpEpoch(browser); };

    const result = await browser.type(1, 'hello', true);

    expect(fake.log.filter((l) => l === 'Input.dispatchKeyEvent')).toEqual([]);
    expect(result).toContain('re-established before Enter, so Enter was not pressed');
    expect(await effectOf(async () => {
      verifies = 0;
      return browser.type(1, 'again', true);
    })).toBe('may_have_occurred');
  });
});
