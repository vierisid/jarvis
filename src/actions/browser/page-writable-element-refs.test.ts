/**
 * #592: a page cannot change which element receives approved text, and a
 * coordinate from a document the browser has left is not acted on.
 *
 * Against a REAL headless Chromium, because every mechanism here is a browser
 * behaviour rather than a decision: whether an isolated world's globals are
 * invisible to the page, whether a main-world `focus` listener fires when the
 * isolated world calls `focus()`, whether a detached node can take focus, and
 * whether a page-initiated navigation changes the loaderId. A fake CDP client
 * would be asserting my own assumptions back at me.
 *
 * Named for the defect rather than the fix, and NOT
 * `snapshot-element-identity.test.ts`, which PR #590 adds.
 *
 * Two of these carry an explicit NEGATIVE CONTROL -- the global-overwrite test
 * and the detached-element test first prove the attack works when driven the
 * old way, so a pass cannot mean "the attack stopped working on its own". The
 * rest assert a refusal AND that the attacker's element is still empty, which
 * is the same guarantee reached from the other side: if the guard were removed
 * the text would land there and the emptiness assertion would fail. Each was
 * additionally confirmed to fail against the pre-fix predicate while it was
 * being written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BrowserController } from './session.ts';
import { chromiumExe, launchTestChromium, type TestChromium } from './fixtures/headless-chromium.ts';

/**
 * Two inputs, a contenteditable, a doomed input, and a same-origin iframe.
 * Served over http rather than data:, because an isolated world and a
 * same-origin iframe both need a real origin.
 */
/**
 * `reviewed` starts with a value ON PURPOSE: the "focus is checked before the
 * value is cleared" guarantee is only assertable if there is something to lose.
 * With an empty input the assertion passes either way and proves nothing.
 *
 * The same-origin iframe is here so the in-frame element ids -- the ones held
 * to the frame digest -- are exercised at all.
 */
const PAGE = `<!doctype html><html><head><title>Refs</title></head><body style="margin:0">
  <input id="reviewed" data-testid="reviewed" value="original" style="width:200px;height:30px">
  <input id="attacker" data-testid="attacker" style="width:200px;height:30px">
  <input id="doomed" data-testid="doomed" style="width:200px;height:30px">
  <div id="editor" contenteditable="true" role="textbox" data-testid="editor" style="width:200px;height:40px">existing</div>
  <div id="host" contenteditable="true" role="textbox" data-testid="host" style="width:200px;height:40px">host</div>
  <iframe id="framed" data-testid="framed" src="/frame" style="width:200px;height:60px"></iframe>
  <a id="link" href="/second" data-testid="link">go</a>
</body></html>`;

const FRAME = `<!doctype html><body style="margin:0">
  <input id="inframe" data-testid="inframe" style="width:150px;height:30px">
</body>`;

const SECOND = `<!doctype html><html><head><title>Second</title></head><body style="margin:0">
  <input id="other" data-testid="other" style="width:200px;height:30px">
</body></html>`;

describe.skipIf(!chromiumExe)('page-writable element refs (#592, integration)', () => {
  let chromium: TestChromium | null = null;
  let browser: BrowserController;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base = '';

  beforeAll(async () => {
    chromium = await launchTestChromium({ profilePrefix: 'jarvis-refs-test-' });
    // autoLaunch: false -- a browser that died mid-suite must fail the test,
    // not be replaced by a headed Chrome on the developer's real profile.
    browser = new BrowserController(chromium.port, undefined, { autoLaunch: false });
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        const body = p === '/second' ? SECOND : p === '/frame' ? FRAME : PAGE;
        return new Response(body, { headers: { 'content-type': 'text/html' } });
      },
    });
    base = `http://127.0.0.1:${server.port}/`;
  });

  afterAll(async () => {
    await browser?.disconnect();
    server?.stop(true);
    await chromium?.close();
  });

  /** Snapshot, and return the snapshot id of the element with this data-testid. */
  const idOf = async (testid: string): Promise<number> => {
    const snap = await browser.snapshot();
    const el = snap.elements.find((e) => e.attrs['data-testid'] === testid);
    if (!el) throw new Error(`no snapshot element for ${testid}: ${JSON.stringify(snap.elements)}`);
    return el.id;
  };

  const valueOf = (id: string) => browser.evaluate(`document.getElementById('${id}').value`);

  const fresh = async () => {
    await browser.navigate(base);
    // navigate() ends in a snapshot, so the ids and the world are live.
  };

  test('a page that overwrites the element global cannot redirect approved text', async () => {
    await fresh();
    const reviewed = await idOf('reviewed');

    // THE ATTACK: the page replaces the array the ids used to resolve through.
    await browser.evaluate(
      `window.__jarvis_elements = [document.getElementById('attacker'),`
      + ` document.getElementById('attacker'), document.getElementById('attacker'),`
      + ` document.getElementById('attacker'), document.getElementById('attacker')]; 'armed'`);

    // NEGATIVE CONTROL: driven the old way -- a MAIN-WORLD read of that global,
    // which is what type() used to do -- the attack works. If this ever stops
    // being true, the test below is no longer evidence of anything.
    await browser.evaluate(
      `(() => { const el = window.__jarvis_elements[${reviewed - 1}];`
      + ` el.focus(); el.value = 'control'; return 'ok'; })()`);
    expect(await valueOf('attacker')).toBe('control');
    await browser.evaluate(`document.getElementById('attacker').value = ''; 'reset'`);

    // THE FIX: type() resolves the id in the isolated world, which the page's
    // write cannot reach.
    const result = await browser.type(reviewed, 'approved text');
    expect(result).not.toContain('Error');
    expect(await valueOf('reviewed')).toBe('approved text');
    expect(await valueOf('attacker')).toBe('');
  });

  test('a page that steals focus on the reviewed element gets nothing typed', async () => {
    await fresh();
    const reviewed = await idOf('reviewed');

    // THE ATTACK: an isolated world shares the DOM *and its events*, so the
    // page's own focus listener fires when type() calls el.focus() and can move
    // focus anywhere. This is the case the isolated world alone does NOT close.
    await browser.evaluate(
      `document.getElementById('reviewed').addEventListener('focus', () => {`
      + ` document.getElementById('attacker').focus(); }); 'armed'`);

    const result = await browser.type(reviewed, 'approved text');
    expect(result).toContain('Error');
    expect(result).toContain('did not take focus');
    // Neither element got the text...
    expect(await valueOf('attacker')).toBe('');
    // ...and the reviewed field kept its ORIGINAL value: the focus is verified
    // BEFORE the value is touched, so a refused focus cannot empty the field
    // the user reviewed. This is why the fixture gives it a value to lose.
    expect(await valueOf('reviewed')).toBe('original');
  });

  test('a page that steals focus on a TIMER, after the focus check, still gets nothing', async () => {
    await fresh();
    const reviewed = await idOf('reviewed');

    // THE ATTACK, aimed at the gap the in-script check cannot see: steal focus
    // on a timer rather than in the focus listener, so the focus script has
    // already returned 'ok' by the time focus moves. This is what the
    // pre-insert re-verify exists for -- and it is the shape the deferred
    // focus event produced naturally before focus emulation was enabled.
    await browser.evaluate(
      `document.getElementById('reviewed').addEventListener('focus', () => {`
      + ` setTimeout(() => document.getElementById('attacker').focus(), 40); }); 'armed'`);

    const result = await browser.type(reviewed, 'approved text');
    expect(result).toContain('Error');
    // Refused BEFORE the insert, which is the difference between preventing the
    // leak and merely reporting it.
    expect(result).toContain('lost focus before anything was typed');
    expect(await valueOf('attacker')).toBe('');
  });

  test('a page cannot redirect the text into a descendant it appended', async () => {
    await fresh();
    const editor = await idOf('editor');

    // THE ATTACK: the reviewed element is a contenteditable, so the page can
    // put its own input INSIDE it and focus that from the element's own focus
    // listener. An earlier version of the guard allowed a descendant to count
    // as focused -- the comment said "focusing a contenteditable can land on a
    // child" -- and that allowance is exactly this hole. It also bought
    // nothing: `activeElement` is measured to be the element itself for every
    // legitimate target, including a contenteditable WITH element children.
    await browser.evaluate(`(() => {
      const ed = document.getElementById('editor');
      const evil = document.createElement('input');
      evil.id = 'evil';
      ed.appendChild(evil);
      ed.addEventListener('focus', () => evil.focus());
      return 'armed';
    })()`);

    const result = await browser.type(editor, 'approved text');
    expect(result).toContain('Error');
    expect(await valueOf('evil')).toBe('');
  });

  test('a page cannot redirect the text into a shadow root it attached', async () => {
    await fresh();
    const host = await idOf('host');

    // THE ATTACK: with focus inside a shadow tree, `activeElement` is the HOST
    // -- so exact equality alone still says "the reviewed element is focused"
    // while the keystrokes go to an input the page put in its shadow root.
    await browser.evaluate(`(() => {
      const h = document.getElementById('host');
      const root = h.attachShadow({ mode: 'open' });
      const inp = document.createElement('input');
      inp.id = 'shadowinput';
      root.appendChild(inp);
      h.addEventListener('focus', () => inp.focus());
      return 'armed';
    })()`);

    const result = await browser.type(host, 'approved text');
    expect(result).toContain('Error');
    const shadowValue = await browser.evaluate(
      `(() => { const r = document.getElementById('host').shadowRoot;`
      + ` const i = r && r.getElementById('shadowinput'); return i ? i.value : '(none)'; })()`);
    expect(shadowValue).toBe('');
  });

  test('typing "into" a frame is refused outright', async () => {
    await fresh();
    // An iframe enters the snapshot on [data-testid] (a role or tabindex would
    // do it too), and focusing it sends the text into a document the snapshot
    // never described -- possibly on another origin.
    const framed = await idOf('framed');
    const result = await browser.type(framed, 'approved text');
    expect(result).toContain('Error');
    expect(result).toContain('is a frame, not a field');
    expect(await browser.evaluate(
      `document.getElementById('framed').contentDocument.getElementById('inframe').value`)).toBe('');
  });

  test('an element inside a same-origin frame still types normally', async () => {
    // The Google Docs shape, and the case the frame refusal must not catch: the
    // reviewed element is the INPUT inside the frame, not the frame.
    await fresh();
    const inframe = await idOf('inframe');
    const result = await browser.type(inframe, 'typed in frame');
    expect(result).not.toContain('Error');
    expect(await browser.evaluate(
      `document.getElementById('framed').contentDocument.getElementById('inframe').value`))
      .toBe('typed in frame');
  });

  test('a reviewed element the page has detached gets nothing typed anywhere', async () => {
    await fresh();
    const doomed = await idOf('doomed');

    // THE ATTACK: remove the element and leave focus elsewhere. focus() on a
    // detached node is a no-op, so the text would follow whatever still had it.
    await browser.evaluate(
      `document.getElementById('doomed').remove();`
      + ` document.getElementById('attacker').focus(); 'armed'`);

    const result = await browser.type(doomed, 'approved text');
    expect(result).toContain('Error');
    expect(result).toContain('removed from the page');
    expect(await valueOf('attacker')).toBe('');
  });

  test('the element refs are invisible in the page, and the page cannot see the world', async () => {
    await fresh();
    await idOf('reviewed');
    // The array exists (typing works, proved above) but has no name in the page.
    expect(await browser.evaluate('typeof window.__jarvis_elements')).toBe('undefined');
    expect(await browser.evaluate('typeof globalThis.__jarvis_elements')).toBe('undefined');
  });

  test('the snapshot is not fooled by a main-world prototype override', async () => {
    // Not required by #592, but it falls out of the isolated world and is worth
    // holding: a world has its own DOM prototypes, so a page that patches
    // getAttribute cannot change how the snapshot DESCRIBES it either.
    await fresh();
    await browser.evaluate(
      `Element.prototype.getAttribute = function () { return 'LIES'; }; 'patched'`);
    const snap = await browser.snapshot();
    const ids = snap.elements.map((e) => e.attrs['data-testid']);
    expect(ids).toContain('reviewed');
    expect(ids).not.toContain('LIES');
  });

  describe('coordinates across a page-initiated navigation (#592 sibling)', () => {
    test('a click is refused after the page navigates itself', async () => {
      await fresh();
      const reviewed = await idOf('reviewed');

      // The page navigates ITSELF -- no navigate() call, so nothing in the
      // controller had any reason to notice.
      await browser.evaluate(`location.href = '/second'; 'navigating'`);
      await Bun.sleep(1200);

      const result = await browser.click(reviewed);
      expect(result).toContain('Error');
      expect(result).toContain('navigated to a new document');
      // And the new document was not touched: the second page's input is
      // where the old coordinates would have landed.
      expect(await valueOf('other')).toBe('');
    });

    test('typing is refused after the page navigates itself', async () => {
      await fresh();
      const reviewed = await idOf('reviewed');
      await browser.evaluate(`location.href = '/second'; 'navigating'`);
      await Bun.sleep(1200);

      const result = await browser.type(reviewed, 'approved text');
      expect(result).toContain('Error');
      expect(result).toContain('navigated to a new document');
      expect(await valueOf('other')).toBe('');
    });

    test('a hover is refused after the page navigates itself', async () => {
      await fresh();
      const reviewed = await idOf('reviewed');
      await browser.evaluate(`location.href = '/second'; 'navigating'`);
      await Bun.sleep(1200);

      expect(await browser.hover(reviewed)).toContain('navigated to a new document');
    });

    test('a same-document pushState does NOT refuse a click', async () => {
      // The guard compares the loaderId alone, on purpose. pushState rewrites
      // frameTree.frame.url while the loaderId holds, and that is how every SPA
      // navigates -- comparing the URL would refuse an ordinary click on Gmail,
      // Linear, and the cell-to-cell moves webapp-templates/gsheets.yaml tells
      // the model to reuse an id across.
      await fresh();
      const reviewed = await idOf('reviewed');
      await browser.evaluate(`history.pushState({}, '', '/spa/view/2'); 'pushed'`);

      const result = await browser.type(reviewed, 'still works');
      expect(result).not.toContain('Error');
      expect(await valueOf('reviewed')).toBe('still works');
    });

    test('a fragment change does NOT refuse a click', async () => {
      await fresh();
      const reviewed = await idOf('reviewed');
      await browser.evaluate(`location.hash = 'section'; 'hashed'`);

      const result = await browser.type(reviewed, 'also works');
      expect(result).not.toContain('Error');
      expect(await valueOf('reviewed')).toBe('also works');
    });
  });
});
