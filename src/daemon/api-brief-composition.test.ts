import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiRoutes, setCorsOrigin, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';
import { BriefCompositionProvider } from '../brief/composition';
import { BriefCapabilities } from '../brief/capabilities';
import { registerWorkflowComposition } from '../brief/registrations/workflow-composition';
import { createCompositionRoutes } from '../brief/composition-routes';
import { COMPOSITION_LIMITS } from '../brief/composition-contracts';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from '../workflows/db/index';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';

const base = '/api/brief/workflow-compositions';
const input = { requestId: 'stable-key', prompt: 'Draft a private report on manual trigger.' };
test('real panel auth protects composition submission, recovery and cancellation; 202 does not wait for the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f07-api-')), socket = join(dir, 'api.sock');
  initWorkflowDb(':memory:');
  const provider = new BriefCompositionProvider(getWorkflowDb()); let calls = 0;
  let release!: (value: { text: string }) => void;
  provider.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat() { calls++; return new Promise(resolve => { release = resolve; }); } } }));
  const caps = new BriefCapabilities(registerWorkflowComposition(provider), ['workflowComposition']);
  const sessions = new PanelSessionStore(), session = sessions.create('fixture-device');
  const server = new WebSocketServer(0, socket);
  const previousOrigin = (createApiRoutes({} as ApiContext)['/api/brief/capabilities'] as { GET: () => Response }).GET().headers.get('Access-Control-Allow-Origin')!;
  server.setSidecarManager({ resolvePanelSession: (id: string) => sessions.get(id), openPanelSession: async () => null } as unknown as SidecarManager);
  server.setApiRoutes(createApiRoutes({ briefWorkflowComposition: provider, briefCapabilities: caps } as ApiContext) as Parameters<WebSocketServer['setApiRoutes']>[0]);
  const request = (path: string, method = 'GET', body?: unknown, auth = true) => fetch(`http://localhost${path}`, { unix: socket, method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(auth ? { Cookie: `panel_session=${session.id}` } : {}), 'Content-Type': 'application/json' } });
  try {
    setCorsOrigin('http://localhost:3000'); server.start();
    for (const [path, method] of [['/api/brief/composition-ingredients', 'GET'], [base, 'GET'], [base, 'POST'], [`${base}/missing`, 'GET'], [`${base}/missing/cancel`, 'POST']]) {
      expect((await request(path!, method!, method === 'POST' ? input : undefined, false)).status).toBe(401);
    }
    expect(provider.list()).toEqual([]); expect(calls).toBe(0);
    const capability = await (await request('/api/brief/capabilities')).json();
    expect(capability.capabilities.workflowComposition).toMatchObject({ supported: true, enabled: true });
    expect(capability.capabilities.compositionIngredients).toMatchObject({ supported: false, enabled: false });
    const accepted = await request(base, 'POST', input);
    expect(accepted.status).toBe(202); expect(accepted.headers.get('Cache-Control')).toBe('no-store');
    expect(accepted.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    const receipt = await accepted.json(); const id = receipt.job.jobId;
    expect(receipt).toMatchObject({ created: true, job: { state: 'queued', specification: { prompt: input.prompt } } });
    const replay = await request(base, 'POST', input); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: false, job: { jobId: id } });
    expect((await request(base, 'POST', { ...input, prompt: 'Different' })).status).toBe(409);
    expect(await (await request(`${base}?requestId=${input.requestId}`)).json()).toMatchObject({ jobs: [{ jobId: id }] });
    expect(await (await request(`${base}/${id}`)).json()).toMatchObject({ jobId: id, state: 'running', compositionId: expect.any(String) });
    expect((await request(`${base}/missing`)).status).toBe(404);
    expect(await (await request(`${base}/${id}/cancel`, 'POST')).json()).toMatchObject({ state: 'cancelled' });
    await provider.idle(); release({ text: '{}' }); await Bun.sleep(5);
    expect(calls).toBe(1); expect(getWorkflowDb().query('SELECT * FROM flow').all()).toHaveLength(0);
    provider.stop(); expect((await request(base)).status).toBe(503);
  } finally { provider.stop(); await provider.idle(); server.stop(); setCorsOrigin(previousOrigin); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); }
});

test('default-off, absent, unconfigured and mismatched providers cannot start composition', async () => {
  initWorkflowDb(':memory:');
  const p = new BriefCompositionProvider(getWorkflowDb()), other = new BriefCompositionProvider(getWorkflowDb());
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const req = () => new Request(`http://localhost${base}`, { method: 'POST', body: JSON.stringify(input) });
  try {
    expect((await createCompositionRoutes(new BriefCapabilities(), json)[base].POST(req())).status).toBe(501);
    expect((await createCompositionRoutes(new BriefCapabilities(registerWorkflowComposition(p), ['workflowComposition']), json, other)[base].POST(req())).status).toBe(501);
    expect((await createCompositionRoutes(new BriefCapabilities(registerWorkflowComposition(p), ['workflowComposition']), json, p)[base].POST(req())).status).toBe(503);
    p.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat() { throw Error('Must not call model'); } } }));
    expect((await createCompositionRoutes(new BriefCapabilities(registerWorkflowComposition(p)), json, p)[base].POST(req())).status).toBe(503);
    expect(p.list()).toEqual([]);
  } finally { p.stop(); other.stop(); closeWorkflowDb(); }
});

test('request streams enforce actual byte limits, UTF-8/JSON validation and strict F07 fields', async () => {
  initWorkflowDb(':memory:'); const p = new BriefCompositionProvider(getWorkflowDb());
  p.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat() { throw Error('Must not call model'); } } }));
  const routes = createCompositionRoutes(new BriefCapabilities(registerWorkflowComposition(p), ['workflowComposition']), (data, status = 200) => Response.json(data, { status }), p);
  const submit = (body: BodyInit | null) => routes[base].POST(new Request(`http://localhost${base}`, { method: 'POST', body }));
  try {
    for (const body of [null, '{bad', 'null', '[]', new Uint8Array([0xff]), JSON.stringify({ ...input, connections: [] }), JSON.stringify({ ...input, projectId: 'foreign' })]) {
      expect((await submit(body)).status).toBe(400);
    }
    expect((await submit(JSON.stringify({ ...input, prompt: 'é'.repeat(COMPOSITION_LIMITS.promptBytes) }))).status).toBe(413);
    const forged = new Request(`http://localhost${base}`, { method: 'POST', headers: { 'Content-Length': '1' }, body: new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array(COMPOSITION_LIMITS.bodyBytes)); c.enqueue(new Uint8Array(1)); c.close();
    } }), duplex: 'half' } as RequestInit);
    expect((await routes[base].POST(forged)).status).toBe(413); expect(p.list()).toEqual([]);
    closeWorkflowDb(); expect((await routes[base].GET(new Request(`http://localhost${base}`))).status).toBe(503);
  } finally { p.stop(); closeWorkflowDb(); }
});

test('runtime storage recovery makes receipts unavailable until abandoned jobs are settled', async () => {
  initWorkflowDb(':memory:'); const p = new BriefCompositionProvider(getWorkflowDb(), undefined, 50);
  let calls = 0, release!: (value: { text: string }) => void;
  p.configure(() => ({ pieceRegistry: sampleCatalog(), llm: { async chat() {
    calls++; return new Promise(resolve => { release = resolve; });
  } } }));
  const caps = new BriefCapabilities(registerWorkflowComposition(p), ['workflowComposition']);
  const routes = createCompositionRoutes(caps, (data, status = 200) => Response.json(data, { status }), p);
  const submit = () => routes[base].POST(new Request(`http://localhost${base}`, { method: 'POST', body: JSON.stringify(input) }));
  try {
    const accepted = await submit(); expect(accepted.status).toBe(202);
    const { job } = await accepted.json();
    let finishBody!: () => void;
    const delayedReplay = routes[base].POST(new Request(`http://localhost${base}`, {
      method: 'POST', duplex: 'half', body: new ReadableStream({ start(controller) {
        finishBody = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(input))); controller.close(); };
      } }),
    } as RequestInit));
    getWorkflowDb().exec(`CREATE TRIGGER reject_runtime_job_writes BEFORE UPDATE ON brief_workflow_composition_jobs
      BEGIN SELECT RAISE(ABORT, 'PRIVATE storage diagnostic'); END`);
    await p.idle();
    expect(caps.snapshot().capabilities.workflowComposition).toMatchObject({ ready: false, enabled: false });
    const read = () => routes[base].GET(new Request(`http://localhost${base}?requestId=${input.requestId}`));
    const unavailable = await read();
    expect(unavailable.status).toBe(503); expect(unavailable.headers.get('Cache-Control')).toBe('no-store');
    expect(await unavailable.text()).not.toContain('PRIVATE');
    expect((await submit()).status).toBe(503);
    // This replay passed the route gate before storage failed, then awaited its body.
    finishBody(); expect((await delayedReplay).status).toBe(503);
    expect((await routes[`${base}/:id`].GET(Object.assign(new Request(`http://localhost${base}/${job.jobId}`), { params: { id: job.jobId } }))).status).toBe(503);
    expect((await routes[`${base}/:id/cancel`].POST(Object.assign(new Request(`http://localhost${base}/${job.jobId}/cancel`, { method: 'POST' }), { params: { id: job.jobId } }))).status).toBe(503);
    getWorkflowDb().exec('DROP TRIGGER reject_runtime_job_writes');
    for (let i = 0; i < 300 && p.readiness() !== 'ready'; i++) await Bun.sleep(10);
    expect(caps.snapshot().capabilities.workflowComposition.enabled).toBe(true);
    expect(await (await read()).json()).toMatchObject({ jobs: [{ jobId: job.jobId, state: 'failed', blocker: { code: 'interrupted' } }] });
    const replay = await submit(); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: false, job: { jobId: job.jobId, state: 'failed' } });
    release({ text: '{}' }); await p.idle(); await Bun.sleep(5);
    expect(calls).toBe(1); expect(getWorkflowDb().query('SELECT * FROM flow').all()).toHaveLength(0);
  } finally { p.stop(); await p.idle(); closeWorkflowDb(); }
});
