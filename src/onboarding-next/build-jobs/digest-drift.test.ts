import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest, scopeId } from './input';
import type { Submission } from './types';

// B08 keeps its own copy of B07's scope and request digests so it imports no
// optional sibling. When B07 is physically present, both copies must agree, or
// every worker-time revalidation would report intent_changed.
const intentPath = '../activation-intent/index.ts';
const owner = { actorId: 'owner', projectId: 'project' };
const submissions: Submission[] = [
  { action: 'create', request: { schemaVersion: 1, intentVersion: 1, requestId: 'request-1',
    prompt: 'Draft a meeting follow-up from my supplied notes.', contextRefs: [] }, answers: {} },
  { action: 'create', request: { schemaVersion: 1, intentVersion: 1, requestId: 'request-2',
    prompt: 'Summarise "quoted" text \u00e9 and \u{1F600} plus\nnew lines.', contextRefs: [{ kind: 'note', id: 'b' }, { kind: 'note', id: 'a' }] },
  answers: { zeta: 'last', alpha: 'first', beta_two: 'middle' } },
];

test.skipIf(!existsSync(join(import.meta.dir, intentPath)))('scope and request digests match B07 exactly', async () => {
  const { createActivationIntentProvider, intentScopeId } = await import(intentPath);
  expect(intentScopeId(owner)).toBe(scopeId(owner));
  const validation = createActivationIntentProvider({ enabled: true, authorize: () => owner, servicesFor: () => ({ id: 'intent-binding',
    access: async () => 'ready', assess: async () => ({ schemaVersion: 1, issues: [] }),
    resolve: async (ref: { kind: string; id: string }) => ({ availability: 'ready', reference: { scopeId: scopeId(owner), ref, revision: 'r1' } }),
  }) });
  for (const submission of submissions) {
    const result = await validation.validate(null, structuredClone(submission));
    expect(result).toMatchObject({ availability: 'ready', state: 'ready' });
    expect(result.intent.scopeId).toBe(scopeId(owner));
    expect(result.intent.requestDigest).toBe(digest(submission));
  }
});
