/**
 * Bad input is the caller's mistake, never a 500 with the engine's own text.
 * A body that is not JSON gets a plain 400 on every route that reads one, and
 * a numeric query parameter that is not a number (or is out of range) is
 * clamped to a safe value instead of reaching a query.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createApiRoutes, type ApiContext } from './api-routes.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { createGoal } from '../vault/goals.ts';
import { createMemoryDecisionRoutes } from '../brief/memory-decision-routes.ts';

beforeEach(() => { initDatabase(':memory:', { quiet: true }); });
afterEach(() => closeDb());

type Handler = (req: Request & { params?: Record<string, string> }) => Response | Promise<Response>;
const seen: Record<string, unknown[]> = {};
const record = (name: string) => (...args: unknown[]) => { (seen[name] ??= []).push(args[0]); return []; };
const awarenessService = {
  getSessionHistory: record('sessions'),
  getRecentSuggestionsList: record('suggestions'),
  getBehavioralInsights: record('insights'),
};
const routes = () => createApiRoutes({ config: {}, awarenessService } as unknown as ApiContext) as Record<string, Record<string, Handler>>;

function call(method: string, path: string, url: string, body?: string, params: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) };
  return routes()[path]![method]!(Object.assign(new Request(`http://local${url}`, init), { params }));
}

/** What no caller should ever read in an answer. */
const INTERNALS = /JSON Parse|SyntaxError|SQLiteError|datatype mismatch|evaluating|\/home\/|\.ts:\d|<html|<!doctype/i;

const BODY_ROUTES: Array<[string, string, string]> = [
  ['POST', '/api/vault/entities', '/api/vault/entities'],
  ['POST', '/api/vault/facts', '/api/vault/facts'],
  ['POST', '/api/vault/relationships', '/api/vault/relationships'],
  ['POST', '/api/palette/recent', '/api/palette/recent'],
  ['POST', '/api/config/google', '/api/config/google'],
  ['POST', '/api/onboarding/tutorial/progress', '/api/onboarding/tutorial/progress'],
  ['POST', '/api/onboarding/setup', '/api/onboarding/setup'],
  ['POST', '/api/onboarding/reset', '/api/onboarding/reset'],
  ['POST', '/api/config/llm', '/api/config/llm'],
  ['POST', '/api/goals', '/api/goals'],
  ['POST', '/api/goals/reorder', '/api/goals/reorder'],
];
const BAD_BODIES = ['{not json', '', 'null', '42', '<xml/>'];
/** Routes whose body is optional settings: an empty body means "defaults", the rest is still refused. */
const EMPTY_BODY_MEANS_DEFAULTS = new Set(['/api/onboarding/reset']);

test.each(BODY_ROUTES.flatMap(route => BAD_BODIES.filter(body => body !== '' || !EMPTY_BODY_MEANS_DEFAULTS.has(route[1])).map(body => [...route, body] as const)))(
  '%s %s with body %j is a plain 400',
  async (method, path, url, body) => {
    const response = await call(method, path, url, body);
    const text = await response.text();
    expect(`${response.status} ${text}`).toMatch(/^400 /);
    expect(text).not.toMatch(INTERNALS);
    expect(JSON.parse(text).error).toBeString();
  },
);

test('a reset with a body that is not JSON does not clear anything', async () => {
  const response = await call('POST', '/api/onboarding/reset', '/api/onboarding/reset', '{oops');
  expect(response.status).toBe(400);
});

test('a reset with no body at all still means "everything"', async () => {
  const response = await routes()['/api/onboarding/reset']!.POST!(new Request('http://local/api/onboarding/reset', { method: 'POST' }));
  expect(response.status).toBe(200);
});

test('a goals reorder refused for its content names no exception class', async () => {
  const response = await call('POST', '/api/goals/reorder', '/api/goals/reorder', JSON.stringify([{ id: 5 }]));
  const body = await response.json() as { error: string };
  expect(response.status).toBe(400);
  expect(body.error).not.toMatch(/GoalValidationError|SyntaxError/);
});

test('the memory decision route answers 400, not 503, for a body that is not JSON', async () => {
  const capabilities = { hasProvider: () => true, snapshot: () => ({ capabilities: { memoryStream: { enabled: true } } }) };
  const provider = { readiness: () => 'ready' };
  const route = createMemoryDecisionRoutes(capabilities as never, (body, status = 200) => Response.json(body, { status }), provider as never);
  const response = await route['/api/brief/memory/:id/decision'].POST(Object.assign(
    new Request('http://local/api/brief/memory/f1/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' }),
    { params: { id: 'f1' } },
  ));
  expect(response.status).toBe(400);
});

const LIMIT_VALUES = ['NaN', '-1', '0', '1e999', '99999999999999999999', 'abc', '', '1.5', '%00', '5'];
const LIMIT_ROUTES: Array<[string, string, string | undefined]> = [
  ['/api/awareness/captures', '/api/awareness/captures', undefined],
  ['/api/awareness/sessions', '/api/awareness/sessions', 'sessions'],
  ['/api/awareness/suggestions', '/api/awareness/suggestions', 'suggestions'],
  ['/api/goals/check-ins', '/api/goals/check-ins', undefined],
  ['/api/goals/:id/progress', '/api/goals/GID/progress', undefined],
  ['/api/goals', '/api/goals', undefined],
  ['/api/palette/recent', '/api/palette/recent', undefined],
  ['/api/vault/observations', '/api/vault/observations', undefined],
  ['/api/awareness/insights', '/api/awareness/insights', 'insights'],
];

test.each(LIMIT_ROUTES.flatMap(route => LIMIT_VALUES.map(value => [...route, value] as const)))(
  'GET %s with limit=%j is answered, with a safe number',
  async (path, url, seenAs, value) => {
    const goal = createGoal('Goal', 'task');
    const query = path === '/api/awareness/insights' ? 'days' : 'limit';
    const response = await call('GET', path, `${url.replace('GID', goal.id)}?${query}=${value}`, undefined, { id: goal.id });
    const text = await response.text();
    expect(`${response.status} ${response.headers.get('content-type')}`).toMatch(/^200 application\/json/);
    expect(text).not.toMatch(INTERNALS);
    if (seenAs) {
      const used = seen[seenAs]!.at(-1) as number;
      expect(Number.isSafeInteger(used) && used >= 1 && used <= 500).toBe(true);
    }
  },
);
