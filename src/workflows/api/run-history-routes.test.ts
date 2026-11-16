import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../db/index';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun } from '../db/repos/flow-run';
import { getRunHistoryKeep, resetRunHistorySizeCache } from '../db/repos/run-retention';
import { createWorkflowRoutes, type WorkflowRouteMap } from './routes';

let routes: WorkflowRouteMap; let dir: string; let previous: string | undefined;
beforeEach(() => {
  previous = process.env.JARVIS_WORKFLOW_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'jarvis-runhistory-route-'));
  process.env.JARVIS_WORKFLOW_DATA_DIR = dir;
  initWorkflowDb(':memory:'); resetRunHistorySizeCache(); routes = createWorkflowRoutes();
});
afterEach(() => {
  closeWorkflowDb(); rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR; else process.env.JARVIS_WORKFLOW_DATA_DIR = previous;
});

const handler = (method: 'GET' | 'PATCH') => routes['/api/workflows/run-history']![method]!;
const get = (query = '') => handler('GET')(new Request(`http://x/api/workflows/run-history${query}`) as never);
const patch = (body: unknown) => handler('PATCH')(new Request('http://x/api/workflows/run-history', { method: 'PATCH', body: JSON.stringify(body) }) as never);

function endedRun(daysAgo: number) {
  const flow = createFlow(); const version = createDraftVersion({ flowId: flow.id, displayName: 'h' });
  const r = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  const at = Date.now() - daysAgo * 86_400_000;
  getWorkflowDb().run("UPDATE flow_run SET status = 'SUCCEEDED', finish_time = ?, updated = ? WHERE id = ?", [at, at, r.id]);
  return r.id;
}

test('reads the setting (forever by default) and the size, and previews what a choice would remove', async () => {
  endedRun(10); endedRun(100); endedRun(500);
  const body = await (await get()).json() as Record<string, unknown>;
  expect(body).toMatchObject({ keep: 'forever', runs: 3, options: ['forever', '1y', '90d', '30d'] });
  expect(body.wouldRemoveRuns).toBeUndefined();
  expect((await (await get('?keep=90d')).json() as { wouldRemoveRuns: number }).wouldRemoveRuns).toBe(2);
  expect((await (await get('?keep=1y')).json() as { wouldRemoveRuns: number }).wouldRemoveRuns).toBe(1);
  expect((await get('?keep=tomorrow')).status).toBe(400);
});

test('saving a limit stores it and cleans up now; "forever" deletes nothing', async () => {
  const old = endedRun(500), recent = endedRun(2);
  expect((await patch({ keep: 'forever' })).status).toBe(200);
  await Bun.sleep(20);
  expect(getFlowRun(old)).not.toBeNull();
  const res = await patch({ keep: '90d' });
  expect(res.status).toBe(200);
  expect(getRunHistoryKeep()).toBe('90d');
  for (let i = 0; i < 50 && getFlowRun(old); i++) await Bun.sleep(20);
  expect(getFlowRun(old)).toBeNull();
  // Let the background sweep find its last empty batch before afterEach closes the database.
  await Bun.sleep(50);
  expect(getFlowRun(recent)).not.toBeNull();
});

test('refuses a choice that is not one of the four, and stores nothing', async () => {
  for (const keep of ['1 day', 7, null, undefined]) expect((await patch({ keep })).status).toBe(400);
  expect(getRunHistoryKeep()).toBe('forever');
});
