import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentTemplateDeliveryScope,
  withTemplateDeliveryScope,
  withoutTemplateDelivery,
} from './template-delivery-scope.ts';

/**
 * #586's failure mode IS an unwrapped dispatch site.
 *
 * The bug was not a wrong scope, it was that no consumer had one: a workflow
 * step's `browser_snapshot` spent the chat model's playbook because both went
 * through the same tool object and the same 30-minute memory. Fixing it means
 * every path that dispatches a tool call on a SHARED registry has decided which
 * scope it is, and a comment cannot hold that -- the failure is silent in both
 * directions (a missing playbook, or a playbook delivered twice).
 *
 * So the entrant set is derived from the source and asserted here, the way
 * roles/untrusted-import-guard.test.ts does for the two privileges in
 * roles/untrusted.ts. If this test goes red because a new file entered a scope,
 * that is the moment to check the new path's answer is right, then add it.
 */
const SRC = join(import.meta.dir, '..', '..');

const sourceFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    // Vendored workflow engine: its own tree, its own conventions, and it
    // dispatches Jarvis tools only through the adapter listed below.
    .filter((f) => !f.startsWith('workflows/activepieces/'));

const importersOf = (needle: string): string[] =>
  sourceFiles()
    .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes(needle))
    .sort();

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('who decides a site-playbook delivery scope, derived from the source', () => {
  test('exactly these files enter a delivery scope', () => {
    // The reader of the scope, plus the four dispatch boundaries that set one.
    expect(importersOf('template-delivery-scope.ts')).toEqual([
      // Reads it: refuses a suppressed scope before resolving a template, and
      // keys the redelivery memory by the rest.
      'actions/tools/webapp-template-injection.ts',
      // A sub-agent is its own conversation on the CHAT's tool objects, so it
      // gets its own named scope at both of its dispatch sites.
      'agents/sub-agent-runner.ts',
      // Cannot place a trailer outside the untrusted block (it collapses to one
      // string for a DB receipt), so it must not record a delivery either.
      'authority/deferred-executor.ts',
      // The workflow tool step: drops the trailer (#581), so it never wants a
      // playbook and must not spend one.
      'workflows/adapters/tool-registry.ts',
      // The durable effect boundary, for the same reason as the executor above.
      'workflows/runtime/service-backends.ts',
    ]);
  });

  /**
   * The two collapse boundaries are the subtle half: both call
   * `registry.execute` and both then flatten the carrier with
   * `toolReturnText`, which puts a repo-authored trailer back IN BAND. A
   * delivery is recorded when the tool offers one, not when a consumer places
   * it, so an unwrapped call here spends a slot on a copy that arrives
   * disclaimed. Pinned on the source because neither has a cheap unit seam.
   */
  test('both collapse boundaries dispatch with delivery suppressed', () => {
    const executor = read('authority/deferred-executor.ts');
    expect(executor).toContain('withoutTemplateDelivery(() => registry.execute(request.tool_name, args))');
    // ...and that is the only place it dispatches, so none is left unwrapped.
    expect(executor.match(/registry\.execute\(/g)?.length).toBe(1);

    const backends = read('workflows/runtime/service-backends.ts');
    expect(backends).toContain('withoutTemplateDelivery(() => registry.execute(call.toolCall.name, args))');
    expect(backends.match(/registry\.execute\(/g)?.length).toBe(1);

    const adapter = read('workflows/adapters/tool-registry.ts');
    expect(adapter).toContain('withoutTemplateDelivery(() => this.registry.execute(name, params))');
    expect(adapter.match(/registry\.execute\(/g)?.length).toBe(1);
  });

  /**
   * The sub-agent runner has TWO dispatch sites, and the second one is the one
   * a reader misses: a resumed paused call goes straight to `governedTools`
   * rather than through `executeTool`. Leaving it out would record an approved
   * sub-agent's delivery against the chat -- #586 again, on the path nobody
   * looks at.
   */
  test('both sub-agent dispatch sites run inside the run scope', () => {
    const runner = read('agents/sub-agent-runner.ts');
    expect(runner).toContain('inDeliveryScope(() => executeTool(');
    expect(runner).toContain('inDeliveryScope(() => governedTools(');
    // And `executeTool` is not dispatched anywhere else: two occurrences, its
    // declaration and the one wrapped call. A third means a new dispatch site
    // that has not decided its scope.
    expect(runner.match(/executeTool\(/g)?.length).toBe(2);
  });
});

describe('the ambient scope itself', () => {
  test('absent means the default scope, which is what callers got before it existed', () => {
    expect(currentTemplateDeliveryScope()).toBeUndefined();
  });

  test('the three states are distinguishable, and an id cannot spell the others', () => {
    withTemplateDeliveryScope('suppressed', () => {
      // An id that reads like the other state is still a NAMED scope.
      expect(currentTemplateDeliveryScope()).toEqual({ kind: 'named', id: 'suppressed' });
    });
    withoutTemplateDelivery(() => {
      expect(currentTemplateDeliveryScope()).toEqual({ kind: 'suppressed' });
    });
  });

  test('the scope follows awaited work, which is the only reason it can be ambient', async () => {
    const seen = await withTemplateDeliveryScope('sub-agent:x', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentTemplateDeliveryScope();
    });
    expect(seen).toEqual({ kind: 'named', id: 'sub-agent:x' });
  });

  test('suppression nests inside a named scope, and the inner caller wins', () => {
    withTemplateDeliveryScope('sub-agent:x', () => {
      withoutTemplateDelivery(() => {
        expect(currentTemplateDeliveryScope()).toEqual({ kind: 'suppressed' });
      });
      expect(currentTemplateDeliveryScope()).toEqual({ kind: 'named', id: 'sub-agent:x' });
    });
  });

  test('a scope ends with its call, so nothing inherits it afterwards', async () => {
    // The failure direction that matters: work started OUTSIDE a scope must not
    // see one. A caller that escapes its async context sees ABSENT, which is
    // the default scope -- exactly what every caller had before this existed.
    // The unsafe direction would be picking up somebody else's named scope.
    await withTemplateDeliveryScope('sub-agent:x', async () => {
      expect(currentTemplateDeliveryScope()).toEqual({ kind: 'named', id: 'sub-agent:x' });
    });
    expect(currentTemplateDeliveryScope()).toBeUndefined();
    await new Promise<void>((resolve) => setTimeout(() => {
      expect(currentTemplateDeliveryScope()).toBeUndefined();
      resolve();
    }, 1));
  });
});
