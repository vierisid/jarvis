import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../workflows/db';
import { setEncryptionKey } from '../workflows/db/encryption';
import { upsertConnection } from '../workflows/db/repos/app-connection';
import { CredentialResolver } from '../workflows/credentials/adapter';
import { SandboxApi } from '../workflows/sandbox-api/server';
import { createFlow } from '../workflows/db/repos/flow';
import { createDraftVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun } from '../workflows/db/repos/flow-run';
import { listWorkflowEffects } from '../workflows/db/repos/workflow-effect';
import { WorkflowEffectBoundary, type EffectInvocation } from '../workflows/runtime/effect-boundary';
import { sanitizePieceInput } from '../workflows/runtime/piece-effects';
import { defangPieceProjection } from '../workflows/runtime/piece-effect-receipt';
import { AuthorityEngine } from '../authority/engine';
import { ApprovalManager } from '../authority/approval';
import { EmergencyController } from '../authority/emergency';
import { AuditTrail } from '../authority/audit';
import { attacks } from './fixtures';

let api: SandboxApi | undefined;
beforeEach(() => { initWorkflowDb(':memory:'); setEncryptionKey(Buffer.alloc(32, 21)); });
afterEach(async () => { await api?.stop(); api = undefined; closeWorkflowDb(); setEncryptionKey(null); });

for (const attack of attacks) test(`${attack.id}: source-selected account cannot cross the authenticated engine project`, async () => {
  const ownSecret = 'q21-synthetic-own-secret', otherSecret = 'q21-synthetic-other-secret';
  for (const [projectId, access_token] of [[DEFAULT_IDS.project, ownSecret], ['project-other', otherSecret]]) {
    upsertConnection({ externalId: 'account-other', projectId: projectId!, pieceName: 'fixture-piece', pieceVersion: '1',
      displayName: attack.text, type: 'OAUTH2', value: { access_token } });
  }
  let managedCalls = 0;
  const resolver = new CredentialResolver();
  resolver.register({ id: 'fixture', pieceNames: [], canResolve: id => id === 'jarvis:fixture', resolve: async () => {
    managedCalls++; return { type: 'OAUTH2', value: { access_token: ownSecret } };
  } });
  api = new SandboxApi({ services: { credentialResolver: resolver } });
  await api.start({ port: 0 });
  const identity = { projectId: DEFAULT_IDS.project, runId: 'q21-run', sandboxId: 'q21-sandbox' };
  const { token, expiresAt } = await api.signer.mint(identity, 60);
  api.registry.register({ ...identity, engineToken: token, expiresAt, terminatedAt: null });
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${api.baseUrl}/v1/worker/app-connections`;
  for (const id of ['account-other', 'jarvis:fixture']) {
    const response = await fetch(`${base}/${encodeURIComponent(id)}?${new URLSearchParams({ projectId: 'project-other', pieceName: 'fixture-piece', note: attack.text })}`, { headers });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain(ownSecret); expect(body).not.toContain(otherSecret);
  }
  expect(managedCalls).toBe(0);
  const own = await fetch(`${base}/account-other?${new URLSearchParams({ note: attack.text })}`, { headers });
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ projectIds: [DEFAULT_IDS.project], value: { access_token: ownSecret } });
});

test('piece output cannot forge approval, change the frozen account, or copy auth into the review projection', async () => {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Synthetic Q21', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'send', type: 'PIECE', settings: {
      pieceName: '@jarvispieces/piece-jarvis-tool', actionName: 'invoke', input: {},
    } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const approvals = new ApprovalManager();
  const boundary = new WorkflowEffectBoundary({ approvalManager: approvals, auditTrail: new AuditTrail(),
    emergencyController: new EmergencyController(), authorityEngine: new AuthorityEngine({ default_level: 10,
      governed_categories: ['send_email'], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }) });
  const syntheticSecret = 'q21-synthetic-not-a-credential';
  const raw = { body: attacks[2].text, account: 'account-own', approved: true, auth: { access_token: syntheticSecret } };
  const projected = defangPieceProjection(sanitizePieceInput(raw));
  expect(JSON.stringify(projected)).not.toContain(syntheticSecret);
  const effects: unknown[] = [];
  const invocation: EffectInvocation = { context: { runId: run.id, projectId: run.projectId, stepName: 'send', executionPath: [] },
    piece: '@jarvispieces/piece-jarvis-tool', action: 'invoke', route: 'tool', toolName: 'send_email', category: 'send_email', toolCategory: 'email',
    request: projected, prepare: () => ({ arguments: projected, target: { account: 'account-own' } }),
    execute: async args => { effects.push(args); return 'synthetic receipt'; } };
  expect((await boundary.invoke(invocation)).approval).toBeDefined();
  expect(effects).toHaveLength(0);
  expect(approvals.getPending()).toHaveLength(1);
  const record = listWorkflowEffects(run.id)[0]!;
  expect(record.status).toBe('pending');
  expect(record.target).toMatchObject({ account: 'account-own' });
  expect(JSON.stringify(approvals.getPending())).not.toContain(syntheticSecret);
  approvals.approve(record.approvalId!, 'synthetic-user-click');
  await expect(boundary.invoke({ ...invocation, request: { ...projected, account: 'account-other' } })).rejects.toThrow('changed');
  expect(effects).toHaveLength(0);
  expect((await boundary.invoke(invocation)).result).toBe('synthetic receipt');
  expect(effects).toHaveLength(1);
  await boundary.invoke(invocation);
  expect(effects).toHaveLength(1);
});
