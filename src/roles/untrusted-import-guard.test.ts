import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two privileges in roles/untrusted.ts are safe only because of WHO calls them.
 * A comment cannot hold that, because both failure modes are silent and both end
 * with attacker-controlled text outside an untrusted block -- so the caller set
 * is derived from the source here and asserted.
 *
 * This is the guard #529 wrote for SITE_INSTRUCTION_TOOLS, kept after #560
 * deleted the thing it guarded and pointed at what replaced it.
 */
const SRC = join(import.meta.dir, '..');

const sourceFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    // Vendored workflow engine: a separate tree with its own conventions, and it
    // imports none of this. Walking it costs seconds and finds nothing.
    .filter((f) => !f.startsWith('workflows/activepieces/'));

const importersOf = (needle: string, skip: readonly string[]): string[] =>
  sourceFiles()
    .filter((rel) => !skip.includes(rel))
    .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes(needle))
    .sort();

describe('the privileges in roles/untrusted.ts stay where they were argued for', () => {
  /**
   * `unsafeUntrustedNoncesForTests` reads delimiter tags out of text. Since #560
   * payloads reach the model byte-exact, so content CAN print a well-formed open
   * line and appear in that list -- which makes this function a boundary locator
   * over attacker-controlled text, the exact shape #560 was filed to remove.
   *
   * It is safe for a test, which already knows which block it built. Production
   * never locates a boundary: it holds the tag because `wrapUntrusted` just drew
   * it. If this test fails, the fix is almost certainly NOT to add the file to
   * the skip list.
   */
  test('no production file locates a delimiter tag', () => {
    expect(importersOf('unsafeUntrustedNoncesForTests', ['roles/untrusted.ts'])).toEqual([]);
  });

  /**
   * `withTrustedTrailer` marks text as repo-authored, and its caller places that
   * text OUTSIDE the untrusted block. Exactly one module has a reason to: the
   * webapp template delivery, whose instructions come from
   * vault/webapp-template-seeds.ts and are not writable by any tool.
   */
  test('only the webapp template delivery mints a trusted trailer', () => {
    expect(importersOf('withTrustedTrailer(', ['roles/untrusted.ts'])).toEqual([
      'actions/tools/webapp-template-injection.ts',
    ]);
  });

  /**
   * The seam constant is gone. A reintroduced one would mean something is again
   * deciding a trust boundary by matching a string in a tool result.
   */
  test('nothing searches tool results for a site-instructions separator', () => {
    expect(importersOf('SITE_INSTRUCTIONS_MARKER', [])).toEqual([]);
    expect(importersOf('SITE_INSTRUCTION_TOOLS', [])).toEqual([]);
  });
});
