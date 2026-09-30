import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUntrustedSourceTool } from './untrusted.ts';

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
   * `withDocumentCard` asks the chat loop to render a download card naming a
   * document (#584). The card is what the orchestrator used to recover with a
   * regex over the framed tool result, which is what let a page forge one; the
   * whole point of the carrier is that only a producer which knows the document
   * STRUCTURALLY can mint it. One module does.
   */
  test('only the document tool mints a download card', () => {
    expect(importersOf('withDocumentCard(', ['roles/untrusted.ts'])).toEqual([
      'actions/tools/documents.ts',
    ]);
  });

  /**
   * And nothing goes looking for the rendered marker. `document-card.ts` spells
   * it once, to WRITE it; a second speller would mean something is again
   * deciding a trust boundary by matching a string in a tool result.
   *
   * This one walks `ui/` as well as `src/`, because `ui/` is where the only
   * reader that ever existed lived (`components/chat/MarkdownContent.tsx`,
   * deleted in f7f2eea0), and a restored consumer would land there. The needle
   * is the loose `jarvis:doc` rather than the full comment so that a reader
   * spelled as a pattern -- `/<!-- jarvis:doc[^>]*-->/` -- cannot slip past a
   * literal match.
   *
   * NOTE the current answer is "no readers at all", which is a symptom and not
   * a goal: see the header of actions/tools/document-card.ts.
   */
  test('the document marker has one producer and no readers, in src OR ui', () => {
    const roots = [SRC, join(SRC, '..', 'ui', 'src')];
    const spellers = roots.flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
        .filter((f) => !f.startsWith('workflows/activepieces/'))
        .filter((f) => readFileSync(join(root, f), 'utf8').includes('jarvis:doc'))
        .map((f) => `${root === SRC ? 'src' : 'ui/src'}/${f}`),
    ).sort();
    expect(spellers).toEqual(['src/actions/tools/document-card.ts']);
  });

  /**
   * A third privilege, created by #582: framing a TOOL RETURN rather than a
   * prompt.
   *
   * Every dispatch caps a tool result at `MAX_TOOL_RESULT_CHARS` BEFORE calling
   * `markUntrustedToolResult`, and that order is what makes `wrapUntrusted`'s
   * "never partially framed" invariant hold there -- the payload is sliced, then
   * the frame is drawn around the sliced text. A caller that frames its own
   * return inverts it, so an upstream slice can drop the closing delimiter and
   * leave the model a block that never ends.
   *
   * `wrapUntrusted` cannot enforce that; only the caller can, by capping its
   * payload itself. `actions/tools/manage-workflow.ts` does
   * (`FRAMED_PAYLOAD_MAX_CHARS`), and it is the only tool that frames a return.
   * Every other caller frames into a PROMPT, where no cap follows. So the set is
   * pinned here the same way the two above are: a second tool-return framer has
   * to come with its own cap and its own line in this list.
   */
  test('only one framing caller is a tool return; the rest frame a prompt', () => {
    expect(importersOf('wrapUntrusted(', ['roles/untrusted.ts'])).toEqual([
      // TOOL RETURN. Owns its own payload cap -- see #582.
      'actions/tools/manage-workflow.ts',
      // Prompts, all of them: no dispatch cap applies after the frame.
      'daemon/event-reactor.ts',
      'daemon/index.ts',
      'goals/rhythm.ts',
      'roles/prompt-builder.ts',
      'sites/prompt-context.ts',
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

  /**
   * #529's derived caller guard, restored and re-aimed.
   *
   * #529 derived the `withInstructions(` callers from source and compared them
   * to `SITE_INSTRUCTION_TOOLS`. #560 deleted that list, and with it the guard --
   * but the invariant underneath it was never about the list. It is: a tool that
   * returns page content must be FRAMED. The trailer is repo-authored and
   * harmless, so the hazard is not the trailer; it is that
   * `markUntrustedToolResult` returns an unframed result for a tool it does not
   * recognise, and the caller then appends a trailer to it, which reads as a
   * page that was never disclaimed.
   *
   * So this asserts the thing that matters directly, for every tool that emits
   * one. Attribution is "the nearest `name: '...'` above the call", exact for how
   * these tools are declared but not a parser: a COMMENT mentioning
   * `withInstructions(` under another tool would read as a caller and fail here.
   * If that is why it went red, move the mention.
   */
  test('every tool that attaches template instructions is framed, derived from the source', () => {
    const callers = new Set<string>();
    for (const rel of sourceFiles()) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      if (!text.includes('withInstructions(')) continue;
      let current: string | null = null;
      for (const line of text.split('\n')) {
        const declared = /^\s*name: '([a-z_]+)',/.exec(line);
        if (declared) current = declared[1]!;
        if (line.includes('withInstructions(') && current) callers.add(current);
      }
    }
    // Non-vacuous: the producers exist and are found.
    expect([...callers].sort()).toEqual(['browser_navigate', 'browser_snapshot']);
    for (const name of callers) {
      expect(`${name}:${isUntrustedSourceTool(name, 'browser')}`).toBe(`${name}:true`);
    }
  });
});
