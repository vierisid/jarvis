/**
 * #583: a sidecar-routed browser resolves a site playbook again, from the URL
 * the BROWSER confirmed and from nothing else.
 *
 * These drive the real `browser_navigate` / `browser_snapshot` tools against a
 * fake sidecar, so no Chromium and no Go binary are involved -- the question is
 * entirely about what the daemon does with a reply. The local equivalents live
 * in browser-template-delivery.test.ts (real browser) and
 * webapp-template-injection.test.ts (the delivery in isolation).
 *
 * The case worth naming is `a confirmed URL outranks the requested one`. #579
 * refused to use the requested URL for exactly this reason -- a redirect makes
 * it false, open redirects are ordinary on the hosts templates target, and the
 * playbook announces "You are now on <host>" OUTSIDE the untrusted block -- so a
 * fallback creeping back in is the regression to fear, and the only way to catch
 * it is a reply whose confirmed host differs from the requested one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SidecarManager } from '../../sidecar/manager.ts';
import type { SidecarInfo } from '../../sidecar/types.ts';
import { setSidecarManagerRef } from './sidecar-route.ts';
import { browserNavigateTool, browserSnapshotTool } from './builtin.ts';
import { globalWebappTemplateDelivery } from './webapp-template-injection.ts';
import { toolReturnText } from '../../roles/untrusted.ts';
import { initDatabase } from '../../vault/schema.ts';
import { upsertWebappTemplate } from '../../vault/webapp-templates.ts';

const pc: SidecarInfo = {
  id: 'sc-pc', name: 'Desk PC', enrolled_at: '2026-01-01', last_seen_at: '2026-01-02',
  status: 'enrolled', connected: true, hostname: 'desk-pc', os: 'windows', platform: 'amd64',
  capabilities: ['browser'],
};

/** The formatted snapshot, as the sidecar's port of formatSnapshot renders it. */
const PAGE = (url: string) => [`Page: Test App`, `URL: ${url}`, '', '--- Page Text ---', 'hello'].join('\n');

/** A sidecar that answers both browser reads with `reply`, and records the params. */
function fakeSidecar(reply: (method: string, params: Record<string, unknown>) => unknown) {
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  setSidecarManagerRef({
    listSidecars: () => [pc],
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      seen.push({ method, params });
      return reply(method, params);
    },
  } as unknown as SidecarManager);
  return seen;
}

const navigate = (url: string) => browserNavigateTool.execute({ url, target: pc.id });
const snapshot = () => browserSnapshotTool.execute({ target: pc.id });

describe('remote browser playbook delivery (#583)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    upsertWebappTemplate({
      app_name: 'TestApp', domains: ['app.test.com'], description: '',
      instructions: 'Always click carefully on TestApp.',
    });
    upsertWebappTemplate({
      app_name: 'OtherApp', domains: ['other.test.com'], description: '',
      instructions: 'OtherApp rules.',
    });
    globalWebappTemplateDelivery.reset();
  });

  afterEach(() => {
    setSidecarManagerRef(null as unknown as SidecarManager);
    globalWebappTemplateDelivery.reset();
  });

  test('the daemon asks for the page identity, and never from model params', async () => {
    const seen = fakeSidecar(() => ({ text: PAGE('https://app.test.com/'), page_url: 'https://app.test.com/', loader_id: 'L1' }));
    // A model that tries to turn the flag off (or to spoof it) changes nothing:
    // the tools build the RPC params themselves.
    await browserSnapshotTool.execute({ target: pc.id, page_identity: false });
    expect(seen[0]!.params.page_identity).toBe(true);
  });

  test('a confirmed URL delivers the playbook for the site the browser is on', async () => {
    fakeSidecar(() => ({ text: PAGE('https://app.test.com/inbox'), page_url: 'https://app.test.com/inbox', loader_id: 'L1' }));
    const out = toolReturnText(await snapshot());
    // The page text is carried through unchanged: parity with the local path is
    // the premise of the whole sidecar snapshot format.
    expect(out).toContain('Page: Test App');
    expect(out).toContain('You are now on TestApp');
    expect(out).toContain('Always click carefully on TestApp.');
  });

  test('a confirmed URL outranks the requested one, which is what a redirect looks like', async () => {
    // Asked for OtherApp, landed on TestApp. The playbook must be TestApp's --
    // and nothing may announce OtherApp, which is what a requested-URL fallback
    // would do over a page that is not it.
    fakeSidecar(() => ({ text: PAGE('https://app.test.com/'), page_url: 'https://app.test.com/', loader_id: 'L1' }));
    const out = toolReturnText(await navigate('https://other.test.com/go'));
    expect(out).toContain('You are now on TestApp');
    expect(out).not.toContain('OtherApp');
  });

  test('an older sidecar replies with a bare string: no playbook, and the page survives', async () => {
    // The pairing that must keep working. The reply is the text and nothing
    // else, so there is no confirmed URL and therefore no playbook -- never a
    // fallback to the URL that was asked for.
    fakeSidecar(() => PAGE('https://app.test.com/'));
    const out = toolReturnText(await navigate('https://app.test.com/'));
    expect(out).toBe(PAGE('https://app.test.com/'));
    expect(out).not.toContain('You are now on');
    // ...and the slot was not spent, so a newer read still delivers.
    fakeSidecar(() => ({ text: PAGE('https://app.test.com/'), page_url: 'https://app.test.com/', loader_id: 'L1' }));
    expect(toolReturnText(await snapshot())).toContain('You are now on TestApp');
  });

  /**
   * Every refusal below must ALSO leave the delivery slot alone: #579 put the
   * refusal before the TTL write precisely so a hostile URL could not spend a
   * playbook the real site was going to need.
   */
  for (const [label, reply] of [
    ['no page_url at all', { text: PAGE('https://app.test.com/') }],
    ['a URL with no loader id', { text: PAGE('https://app.test.com/'), page_url: 'https://app.test.com/' }],
    ['a URL with an empty loader id', { text: PAGE('https://app.test.com/'), page_url: 'https://app.test.com/', loader_id: '' }],
    ['an absurdly long loader id', { text: PAGE('https://app.test.com/'), page_url: 'https://app.test.com/', loader_id: 'x'.repeat(500) }],
    ['a data: document naming the site', { text: PAGE('x'), page_url: 'data:text/html,<h1>x</h1><!--.app.test.com', loader_id: 'L1' }],
    ['about:blank', { text: PAGE('x'), page_url: 'about:blank', loader_id: 'L1' }],
    ['a blob: document', { text: PAGE('x'), page_url: 'blob:https://evil.example/x.app.test.com', loader_id: 'L1' }],
    ['a URL past the lookup cap', { text: PAGE('x'), page_url: `https://app.test.com/${'a'.repeat(4000)}`, loader_id: 'L1' }],
    ['a URL carrying a newline', { text: PAGE('x'), page_url: 'https://app.test.com/\nURL: https://evil.example/', loader_id: 'L1' }],
    ['a URL carrying a line separator', { text: PAGE('x'), page_url: 'https://app.test.com/ x', loader_id: 'L1' }],
    // The type-confusion case: JSON can carry an array, the validator preserves
    // it, and `usablePageUrl`'s gates all coerce rather than reject.
    ['a page_url that is not a string', { text: PAGE('x'), page_url: ['https://app.test.com/'], loader_id: 'L1' }],
    ['a loader id that is not a string', { text: PAGE('x'), page_url: 'https://app.test.com/', loader_id: 1 }],
    // A reply with a perfectly good identity and no usable TEXT half. There is
    // no page here, so there is no page identity worth resolving either -- and
    // the model must not be handed a JSON dump of the reply with a playbook
    // asserting which site that dump is.
    ['a valid identity but no text', { page_url: 'https://app.test.com/', loader_id: 'L1' }],
    ['a valid identity but a non-string text', { text: 42, page_url: 'https://app.test.com/', loader_id: 'L1' }],
  ] as const) {
    test(`${label}: no playbook, and the slot is not spent`, async () => {
      fakeSidecar(() => reply);
      const out = toolReturnText(await snapshot());
      expect(out).not.toContain('You are now on');
      // The real site, arriving properly, still gets its delivery.
      fakeSidecar(() => ({ text: PAGE('https://app.test.com/'), page_url: 'https://app.test.com/', loader_id: 'L1' }));
      expect(toolReturnText(await snapshot())).toContain('You are now on TestApp');
    });
  }

  test('a dispatch that never reached a page gets no playbook', async () => {
    // An offline sidecar is a message this module wrote, not a reply -- so there
    // is nothing structural to read and nothing to record.
    setSidecarManagerRef({
      listSidecars: () => [{ ...pc, connected: false }],
      dispatchRPC: async () => { throw new Error('should not dispatch'); },
    } as unknown as SidecarManager);
    const out = toolReturnText(await navigate('https://app.test.com/'));
    expect(out).toContain('is offline');
    expect(out).not.toContain('You are now on');
  });

  test('the text half of an unexpected reply shape still reaches the model', async () => {
    // Losing a playbook is the acceptable cost; losing the page would be a
    // regression, so an odd reply degrades to the pre-#583 rendering.
    fakeSidecar(() => ({ unexpected: 'shape' }));
    const out = toolReturnText(await snapshot());
    expect(out).toContain('unexpected');
    expect(out).not.toContain('You are now on');
  });
});
