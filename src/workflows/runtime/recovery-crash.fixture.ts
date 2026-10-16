/** Spawned only by recovery.test.ts with a private database and fake provider. */
import { appendFileSync } from 'node:fs';
import { initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { enqueue, claimNextJob } from '../db/repos/job-queue';
import { WorkflowEffectBoundary } from './effect-boundary';
import { AuthorityEngine } from '../../authority/engine';
import { EmergencyController } from '../../authority/emergency';
const [db, providerLog, boundary] = process.argv.slice(2);
if (!db || !providerLog || !['before', 'during', 'after'].includes(boundary!)) throw new Error('Crash fixture arguments required');
initWorkflowDb(db);
const flow = createFlow({});
const version = createDraftVersion({ flowId: flow.id, displayName: 'Crash fixture', trigger: { name: 'trigger', type: 'EMPTY',
  nextAction: { name: 'send', type: 'PIECE', settings: { pieceName: 'fixture', actionName: 'send', input: {} } } } });
const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
updateRun(run.id, { steps: { previous: { status: 'SUCCEEDED', output: 'partial result' } } });
enqueue({ jobType: 'RUN_FLOW', flowRunId: run.id, payload: { runId: run.id, executionType: 'BEGIN' } }); claimNextJob();
const die = () => process.kill(process.pid, 'SIGKILL');
const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
  learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
const effects = new WorkflowEffectBoundary({ authorityEngine: authority, emergencyController: new EmergencyController(),
  auditTrail: { log: () => { if (boundary === 'after') die(); } } as any });
await effects.invoke({ context: { runId: run.id, projectId: run.projectId, stepName: 'send', executionPath: [] },
  piece: 'fixture', action: 'send', route: 'tool', toolName: 'fake-provider-send', category: 'send_email', toolCategory: 'fixture',
  request: {}, prepare: () => ({ arguments: {}, target: {} }), validateTarget: () => { if (boundary === 'before') die(); },
  execute: async () => { appendFileSync(providerLog, 'accepted\n'); if (boundary === 'during') die(); return { providerReceipt: 'fake-1' }; } });
throw new Error('Fixture did not crash');
