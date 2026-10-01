/**
 * The constants and strings that are duplicated by hand between the daemon and
 * the Go sidecar, and that NOTHING else would notice drifting.
 *
 * The formatter's own numbers are pinned by sidecar/testdata's golden
 * rendering, which both sides produce: change one and a suite fails. These
 * four never reach the rendering, so the golden cannot see them --
 * `MAX_PAGE_CONTROLLED_REPLY` bounds a browser_evaluate reply, the sentinel
 * timeout bounds a renderer read, the retired-ids notice is a model-facing
 * sentence two tools share, and the paging-key set decides when the ids are
 * retired at all. Each was a one-sided edit away from the two browsers
 * behaving differently for the same page, which is the whole class of bug
 * #592's parity rule exists to stop.
 *
 * Reading the Go source is deliberate: the alternative is asserting the number
 * twice, which is what drifting means.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const SIDECAR = join(import.meta.dir, '../../../sidecar');

async function goSource(file: string): Promise<string> {
  return Bun.file(join(SIDECAR, file)).text();
}

describe('constants duplicated across the two browser halves', () => {
  test('the page-controlled reply cap is the same number on both sides', async () => {
    // src/actions/tools/builtin.ts: MAX_PAGE_CONTROLLED_REPLY = 20000
    const ts = await Bun.file(join(import.meta.dir, '../tools/builtin.ts')).text();
    expect(ts).toContain('const MAX_PAGE_CONTROLLED_REPLY = 20000;');
    expect(await goSource('browser_snapshot.go')).toContain('maxPageControlledReply = 20000');
  });

  test('the rendered identity caps are the same numbers on both sides', async () => {
    const ts = await Bun.file(join(import.meta.dir, '../tools/builtin.ts')).text();
    const go = await goSource('browser_snapshot.go');
    expect(ts).toContain('const MAX_RENDERED_TITLE = 2048;');
    expect(go).toContain('maxRenderedTitle = 2048');
    expect(ts).toContain('const MAX_RENDERED_URL = 4096;');
    // The sidecar spells this one as the wire cap it happens to equal.
    expect(go).toContain('maxRenderedURL   = maxWirePageURL');
    expect(go).toContain('maxWirePageURL  = 4096');
  });

  test('the sentinel budget is the same on both sides', async () => {
    const session = await Bun.file(join(import.meta.dir, 'session.ts')).text();
    expect(session).toContain('const DOM_SENTINEL_TIMEOUT_MS = 4000;');
    expect(await goSource('browser_snapshot.go')).toContain('domSentinelTimeout = 4 * time.Second');
  });

  test('the retired-ids notice is one sentence in both languages', async () => {
    const session = await Bun.file(join(import.meta.dir, 'session.ts')).text();
    const sentence = 'Element ids from the previous snapshot no longer apply '
      + '-- take a browser_snapshot before acting on one.';
    // Each side builds it from two string literals; compare the joined text.
    const tsJoined = session.replace(/'\s*\n\s*\+ '/g, '');
    expect(tsJoined).toContain(sentence);
    const goJoined = (await goSource('browser_input.go')).replace(/"\s*\+\n\s*"/g, '');
    expect(goJoined).toContain(sentence);
  });

  test('the keys that retire the ids are the same set on both sides', async () => {
    const session = await Bun.file(join(import.meta.dir, 'session.ts')).text();
    const go = await goSource('browser_input.go');
    // The daemon: one boolean expression; the sidecar: one switch case.
    expect(session).toContain(
      "return key === 'PageDown' || key === 'PageUp' || key === 'Home' || key === 'End';",
    );
    expect(go).toContain('case "PageDown", "PageUp", "Home", "End":');
  });
});
