import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { DEFAULT_IDS } from '../../workflows/db/schema';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { createComposeDraftProvider, createSqliteDraftStore, initializeComposeDraftStore } from './index';
import { examples, recordedGraph } from './fixtures';
import type { DraftServices, Intent, Submission } from './types';

const intentPath = '../activation-intent/index.ts';
test.skipIf(!existsSync(join(import.meta.dir, intentPath)))('real B07 handoff: all three edited tasks need supplied context, then produce recoverable disabled drafts', async () => {
  const { createActivationIntentProvider } = await import(intentPath);
  const directory = mkdtempSync(join(tmpdir(), 'on-b09-intent-'));
  try {
    initWorkflowDb(join(directory, 'vault.db')); initializeComposeDraftStore(getWorkflowDb());
    const scope = { actorId: 'owner', projectId: DEFAULT_IDS.project }, catalog = sampleCatalog();
    configureWorkflowReadiness({ pieces: catalog }); let calls = 0;
    const validation = createActivationIntentProvider({ enabled: true, authorize: () => scope, servicesFor: () => ({ id: 'fixture-services',
      access: async () => 'ready', resolve: async () => ({ availability: 'unavailable' }),
      assess: async (s: Submission) => ({ schemaVersion: 1, issues: s.answers.notes ? [] : [{ id: 'notes', kind: 'detail',
        code: 'missing_context', label: 'Provide notes', message: 'Provide the source text for this draft.', blocking: true }] }),
    }) });
    for (const [i, example] of examples.entries()) {
      const submission: Submission = { action: 'create', request: { schemaVersion: 1, intentVersion: 1,
        requestId: `example-${i}`, prompt: example.prompt + ' Preserve this edit.', contextRefs: [] }, answers: {} };
      const services: DraftServices = { id: 'binding-1', store: createSqliteDraftStore(getWorkflowDb()), access: async () => true,
        validate: (s, signal) => validation.validate(null, s, signal), resolveContext: async () => ({}),
        composer: () => ({ pieceRegistry: catalog, maxAttempts: 1, llm: { async chat() { calls++; return { text: JSON.stringify(recordedGraph(example)) }; } } }),
      };
      const provider = createComposeDraftProvider({ enabled: true, authorize: () => scope, servicesFor: () => services });
      expect(await provider.compose(null, { schemaVersion: 1, intentId: 'forged-ready', submission }, { mayCommit: () => true })).toMatchObject({ reason: 'needs_input' });
      expect(calls).toBe(i);
      submission.answers.notes = example.notes;
      const checked = await validation.validate(null, submission), validated = checked.intent as Intent;
      expect(checked.state).toBe('ready');
      const input = { schemaVersion: 1, intentId: validated.intentId, submission };
      const result = await provider.compose(null, input, { mayCommit: () => true });
      expect(result).toMatchObject({ state: 'saved', flowStatus: 'DISABLED', versionState: 'DRAFT' });
      expect(await provider.reconcile(null, input)).toEqual(result);
    }
    expect(getWorkflowDb().query('SELECT * FROM flow_run').all()).toHaveLength(0); expect(calls).toBe(3);
  } finally { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); }
});
