import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { TaskRegistry } from '../agents/conv/task-registry.ts';
import type { TaskRequest } from '../agents/conv/task-envelope.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';

/**
 * Tests for /api/tasks/paused.
 *
 * The handler is simple but it's a UI contract (the PausedTasksBanner reads
 * the response shape) and has three branches we want covered: no registry
 * (classic mode), no paused tasks, paused tasks present. Building a full
 * AgentService is overkill - we stub the minimum surface the handler reads
 * (`getTaskRegistry`) and cast to ApiContext to satisfy the route signature.
 */

type Handler = (req: Request) => Response | Promise<Response>;
type MethodHandlers = { GET?: Handler; POST?: Handler };

function getHandler(routes: Record<string, unknown>, path: string, method: 'GET' | 'POST'): Handler {
  const route = routes[path] as MethodHandlers | undefined;
  if (!route) throw new Error(`Route ${path} not registered`);
  const handler = route[method];
  if (!handler) throw new Error(`Method ${method} not registered for ${path}`);
  return handler;
}

function makeCtx(registry: TaskRegistry | null): ApiContext {
  return {
    daemonStartedAt: Date.now(),
    healthMonitor: {} as ApiContext['healthMonitor'],
    config: {} as ApiContext['config'],
    agentService: {
      getTaskRegistry: () => registry,
    } as unknown as ApiContext['agentService'],
  } as ApiContext;
}

const sampleRequest: TaskRequest = {
  tier: 'medium',
  template: 'research',
  intent: 'find the capital of italy',
};

describe('GET /api/tasks/paused', () => {
  beforeEach(() => {
    closeDb();
    initDatabase(':memory:');
  });
  afterEach(() => { closeDb(); });

  it('returns an empty list when the task registry is null (classic mode)', async () => {
    const routes = createApiRoutes(makeCtx(null));
    const handler = getHandler(routes, '/api/tasks/paused', 'GET');
    const res = await handler(new Request('http://x/api/tasks/paused'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ tasks: [] });
  });

  it('returns an empty list when no tasks are paused', async () => {
    const registry = new TaskRegistry();
    // A task that runs straight through doesn't leave anything for the banner.
    const rec = registry.create(sampleRequest, 'test');
    registry.transition(rec.id, 'completed', { task_id: rec.id, status: 'completed', summary: '' });

    const routes = createApiRoutes(makeCtx(registry));
    const handler = getHandler(routes, '/api/tasks/paused', 'GET');
    const res = await handler(new Request('http://x/api/tasks/paused'));
    const body = await res.json();
    expect(body.tasks).toEqual([]);
  });

  it('returns paused tasks with the UI contract shape', async () => {
    const registry = new TaskRegistry();
    const rec = registry.create({ ...sampleRequest, original_message: 'verbatim' }, 'test_subsystem');
    registry.recordPauseState(rec.id, 'Which capital?', [{ role: 'user', content: 'find' }]);
    registry.transition(rec.id, 'needs_input', {
      task_id: rec.id,
      status: 'needs_input',
      summary: 'Which capital?',
      needs_input: { question: 'Which capital?' },
    });

    const routes = createApiRoutes(makeCtx(registry));
    const handler = getHandler(routes, '/api/tasks/paused', 'GET');
    const res = await handler(new Request('http://x/api/tasks/paused'));
    const body = await res.json() as { tasks: Array<Record<string, unknown>> };

    expect(body.tasks).toHaveLength(1);
    const task = body.tasks[0]!;
    // Every field the banner reads must be present and correctly named.
    expect(task.id).toBe(rec.id);
    expect(task.template).toBe('research');
    expect(task.intent).toBe('find the capital of italy');
    expect(task.question).toBe('Which capital?');
    expect(typeof task.started_at).toBe('number');
    expect(typeof task.updated_at).toBe('number');
    // The internal conversation buffer must NOT leak through the endpoint -
    // it could contain large/sensitive context the UI doesn't need.
    expect(task.paused_conversation).toBeUndefined();
    expect(task.pausedConversation).toBeUndefined();
  });

  it('excludes running/queued tasks (only needs_input surfaces)', async () => {
    const registry = new TaskRegistry();

    const running = registry.create(sampleRequest, 'test');
    registry.transition(running.id, 'running');

    const paused = registry.create(sampleRequest, 'test');
    registry.recordPauseState(paused.id, 'Q?', []);
    registry.transition(paused.id, 'needs_input', {
      task_id: paused.id, status: 'needs_input', summary: 'Q?', needs_input: { question: 'Q?' },
    });

    const routes = createApiRoutes(makeCtx(registry));
    const handler = getHandler(routes, '/api/tasks/paused', 'GET');
    const res = await handler(new Request('http://x/api/tasks/paused'));
    const body = await res.json() as { tasks: Array<{ id: string }> };

    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.id).toBe(paused.id);
  });

  it('returns empty question string rather than null when a paused task has no question text', async () => {
    // Defensive: a task could pause without a question (edge case in custom
    // runners). The UI reads `question` and would crash on null - empty
    // string keeps the contract narrow.
    const registry = new TaskRegistry();
    const rec = registry.create(sampleRequest, 'test');
    // Transition straight to needs_input without recording a pause state.
    registry.transition(rec.id, 'needs_input', {
      task_id: rec.id, status: 'needs_input', summary: '', needs_input: { question: '' },
    });

    const routes = createApiRoutes(makeCtx(registry));
    const handler = getHandler(routes, '/api/tasks/paused', 'GET');
    const res = await handler(new Request('http://x/api/tasks/paused'));
    const body = await res.json() as { tasks: Array<{ question: string }> };

    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.question).toBe('');
  });
});
