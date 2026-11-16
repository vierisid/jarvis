import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../workflows/db/index.ts';
import { createFlow } from '../workflows/db/repos/flow.ts';
import { createDraftVersion } from '../workflows/db/repos/flow-version.ts';

type Handler = (req: Request) => Response | Promise<Response>;

function searchRoute(): Handler {
  const routes = createApiRoutes({ daemonStartedAt: Date.now(), healthMonitor: {}, config: {} } as unknown as ApiContext);
  return (routes['/api/palette/search'] as { GET: Handler }).GET;
}

describe('GET /api/palette/search workflows', () => {
  // Only the workflow section is wired here; the others warn and are skipped.
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    initWorkflowDb(':memory:');
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    closeWorkflowDb();
  });

  test('finds a workflow older than the newest 100', async () => {
    const old = createFlow();
    createDraftVersion({ flowId: old.id, displayName: 'Quarterly invoice sweep' });
    getWorkflowDb().run('UPDATE flow SET updated = 0 WHERE id = ?', [old.id]);
    for (let i = 0; i < 100; i++) createDraftVersion({ flowId: createFlow().id, displayName: `filler ${i}` });

    const res = await searchRoute()(new Request('http://x/api/palette/search?q=quarterly'));
    const body = await res.json() as { results: Array<{ type: string; id: string }> };
    expect(body.results.filter((r) => r.type === 'workflow').map((r) => r.id)).toEqual([old.id]);
  });
});
