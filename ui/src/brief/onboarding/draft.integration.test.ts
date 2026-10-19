import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { registerOnboarding } from '../../../../src/brief/registrations/onboarding';
import { BriefCompositionProvider } from '../../../../src/brief/composition';
import { createCompositionRoutes } from '../../../../src/brief/composition-routes';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../../../../src/workflows/db';
import { configureWorkflowReadiness } from '../../../../src/workflows/db/repos/flow-readiness';
import { getFlow } from '../../../../src/workflows/db/repos/flow';
import { getFlowVersion } from '../../../../src/workflows/db/repos/flow-version';
import { sampleCatalog } from '../../../../src/workflows/runtime/test-fixtures';
import { OnboardingDraft, onboardingComposition } from './draft';
let directory = '', provider: BriefCompositionProvider | undefined;
afterEach(async () => { provider?.stop(); await provider?.idle(); closeWorkflowDb(); if (directory) rmSync(directory, { recursive: true, force: true }); });

test('the onboarding handoff uses real F-07 routes/SQLite, recovers a lost response and creates one disabled populated draft with zero runs', async () => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f26-'));
  initWorkflowDb(join(directory, 'fixture.db')); configureWorkflowReadiness({ pieces: sampleCatalog() });
  let modelCalls = 0;
  provider = new BriefCompositionProvider(getWorkflowDb(), undefined, 1000);
  provider.configure(() => ({ pieceRegistry: sampleCatalog(), maxAttempts: 1, llm: { async chat() {
    modelCalls++; return { text: JSON.stringify({ displayName: 'Weekly notes', trigger: { name: 'trigger', type: 'EMPTY',
      nextAction: { name: 'report', type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'Draft weekly notes for review. Do not send.' } } } } }) };
  } } }));
  const capabilities = new BriefCapabilities([
    { id: 'workflowComposition', provider }, ...registerOnboarding(() => ({ targets: true, progress: true, draftHandoff: true })),
  ], ['workflowComposition', 'onboarding']);
  const routes = createCompositionRoutes(capabilities, (value, status = 200) => Response.json(value, { status }), provider);
  let loseResponse = true; const urls: string[] = [];
  const api = onboardingComposition((async (input: string, init?: RequestInit) => {
    urls.push(`${init?.method ?? 'GET'} ${input}`);
    const req = new Request(`http://fixture.invalid${input}`, init);
    if (input === '/api/brief/workflow-compositions') {
      const response = await routes['/api/brief/workflow-compositions'].POST(req);
      if (loseResponse) { loseResponse = false; throw Error('Lost after acceptance'); }
      return response;
    }
    const id = input.split('/').at(-1)!;
    return routes['/api/brief/workflow-compositions/:id'].GET(Object.assign(req, { params: { id } }));
  }) as typeof fetch);
  let saved: string | null = null; const opened: unknown[] = [];
  const storage = { read: () => saved, write: (value: string) => { saved = value; } };
  const host = { capabilities: () => capabilities.snapshot(), roomAvailable: () => true,
    canLeave: async () => true, commit: (route: unknown) => { opened.push(route); } };
  const first = new OnboardingDraft('test-account', storage, host, api, () => 'durable-onboarding-request');
  first.setRoutine('Draft my weekly notes for review. Do not send them.');
  await first.prepare(); expect(first.getSnapshot().error).toContain('Could not confirm');
  first.dispose(); await provider.idle();
  const recovered = new OnboardingDraft('test-account', storage, host, api);
  await recovered.prepare(); const receipt = recovered.getSnapshot().job!;
  expect(receipt.state).toBe('draft_ready'); expect(modelCalls).toBe(1);
  expect(getFlow(receipt.workflow!.flowId)).toMatchObject({ status: 'DISABLED', published_version_id: null });
  expect(getFlowVersion(receipt.workflow!.versionId)).toMatchObject({ state: 'DRAFT', trigger: { nextAction: { name: 'report' } } });
  expect(getWorkflowDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM flow').get()!.n).toBe(1);
  expect(getWorkflowDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM flow_run').get()!.n).toBe(0);
  expect(opened).toEqual([]); await recovered.openDraft();
  expect(opened).toEqual([{ room: 'workflow-draft', selection: receipt.workflow }]);
  expect(urls.every(url => /^POST \/api\/brief\/workflow-compositions$/.test(url))).toBe(true);
});
