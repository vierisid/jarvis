import { expect, test } from 'bun:test';
import { createHostTransport } from './http';

test('a refused write keeps what the server said, so the page can word it', async () => {
  const body = { error: 'x', issues: [{ node: 'step_2', message: 'Reference "step_1" is missing' }] };
  const transport = createHostTransport((async () => Response.json(body, { status: 422 })) as unknown as typeof fetch);
  const error = await transport.json('/api/workflows/f/publish', { method: 'POST' }).catch((e: unknown) => e) as { message: string; status: number; body: unknown };
  expect(error.message).toBe('Request unavailable (422)');
  expect(error.status).toBe(422);
  expect(error.body).toEqual(body);
  const conflict = await createHostTransport((async () => Response.json({ code: 'workflow_removed' }, { status: 409 })) as unknown as typeof fetch).json('/api/x').catch((e: unknown) => e) as { status: number; body: unknown };
  expect(conflict.status).toBe(409);
  expect(conflict.body).toEqual({ code: 'workflow_removed' });
  const text = await createHostTransport((async () => new Response('nope', { status: 502 })) as unknown as typeof fetch).json('/api/x').catch((e: unknown) => e) as { status: number; body: unknown };
  expect(text.status).toBe(502);
  expect(text.body).toBeNull();
});
