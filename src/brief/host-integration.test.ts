import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../workflows/db';
import { createGoal } from '../vault/goals';
import { createEntity } from '../vault/entities';
import { createFact, getFact, correctFact } from '../vault/facts';
import { GoalMeasurements } from './goal-measurements';
import { MemoryStream } from './memory-stream';
import { MemoryUsageLedger } from '../vault/memory-usage';
import { BriefCapabilities } from './capabilities';
import { createBriefRoutes } from './routes';
import { createDomainPorts } from '../../ui/src/brief/host/domain-ports';
import { createHostTransport } from '../../ui/src/brief/host/http';
import { createGoalMeasurementRoutes } from './goal-measurement-routes';
import { createMemoryDecisionRoutes } from './memory-decision-routes';
const json = (value: unknown, status = 200) => Response.json(value, { status });
let goals: GoalMeasurements, memory: MemoryStream, caps: BriefCapabilities;
beforeEach(() => { closeWorkflowDb(); initWorkflowDb(':memory:'); const db = getWorkflowDb(); goals = new GoalMeasurements(db);
  const usage = new MemoryUsageLedger(db, () => true); usage.start(); memory = new MemoryStream(db, usage, undefined, () => true);
  caps = new BriefCapabilities([{ id: 'goalMeasurements', provider: goals }, { id: 'memoryStream', provider: memory }, { id: 'memoryUsage', provider: usage }], ['goalMeasurements', 'memoryStream', 'memoryUsage']); });
afterEach(() => closeWorkflowDb());
const request = (id: string, input: unknown) => Object.assign(new Request(`http://localhost/api/brief/memory/${id}/decision`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }), { params: { id } });
test('complete measured goal list crosses the legacy 100-row limit and retains descendants and completed goals', async () => {
  const root = createGoal('Root', 'objective');
  for (let i = 0; i < 130; i++) createGoal(`Stage ${i}`, 'key_result', { parent_id: root.id });
  const route = createGoalMeasurementRoutes(caps, json, goals)['/api/brief/goals'].GET;
  const response = await route(new Request('http://localhost/api/brief/goals'));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json(); expect(body.data).toHaveLength(131);
  const http = createHostTransport((async () => Response.json(body)) as unknown as typeof fetch);
  const ports = createDomainPorts(DEFAULT_IDS.project, http, { setItem() {} });
  const read = await ports.goals.read(); expect(read.status).toBe('ready');
  if (read.status === 'ready') { expect(read.data).toHaveLength(1); expect(read.data[0]!.stages).toHaveLength(130); }
  http.stop();
});
test('memory correction compares the displayed revision in the same canonical write transaction', async () => {
  const entity = createEntity('person', 'Local owner'), fact = createFact(entity.id, 'likes', 'Tea', { source: 'dashboard' });
  const before = memory.detail(fact.id); if (before.state !== 'ready' || !('revision' in before.data)) throw Error('No fact');
  const route = createMemoryDecisionRoutes(caps, json, memory)['/api/brief/memory/:id/decision'].POST;
  const saved = await route(request(fact.id, { kind: 'correct', revision: before.data.revision, object: 'Coffee', reason: 'Preference changed', confirmed: true }));
  expect(saved.status).toBe(200); const receipt = await saved.json(); expect(receipt.state).toBe('saved'); expect(getFact(receipt.factId)?.object).toBe('Coffee');
  const stale = await route(request(fact.id, { kind: 'correct', revision: before.data.revision, object: 'Water', reason: 'Late edit', confirmed: true }));
  expect(stale.status).toBe(409); expect(getFact(receipt.factId)?.object).toBe('Coffee');
});
test('unconfirmed and oversized memory writes have no effect', async () => {
  const entity = createEntity('person', 'Local owner'), fact = createFact(entity.id, 'likes', 'Tea', { source: 'dashboard' });
  const route = createMemoryDecisionRoutes(caps, json, memory)['/api/brief/memory/:id/decision'].POST;
  expect((await route(request(fact.id, { kind: 'confirm', revision: 'x', reason: 'yes' }))).status).toBe(400);
  expect((await route(request(fact.id, { reason: 'x'.repeat(21000) }))).status).toBe(413);
  expect(getFact(fact.id)?.object).toBe('Tea');
});
test('host descriptor never supplies release permission and remains unavailable without an owner', async () => {
  const routes = createBriefRoutes(caps, json);
  expect((await routes['/api/brief/host'].GET()).status).toBe(501);
});
test('authorization loss retires transport, but an ordinary action refusal does not retire it', async () => {
  let status = 403, revoked = 0;
  const transport = createHostTransport((async () => Response.json({}, { status })) as unknown as typeof fetch, () => { revoked++; });
  expect((await transport.request('/api/brief/test')).status).toBe(403); expect(revoked).toBe(0);
  status = 401; await expect(transport.request('/api/brief/test')).rejects.toThrow(); expect(revoked).toBe(1);
  transport.stop(); await expect(transport.request('/api/brief/test')).rejects.toThrow();
});
