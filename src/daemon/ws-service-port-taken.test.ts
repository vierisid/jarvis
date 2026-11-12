import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { WebSocketService } from './ws-service.ts';
import { PortUnavailableError } from './port-check.ts';

// A port taken after the early check (a race) still says which port, not Bun's stack.
let holder: Server | null = null;
afterEach(() => { holder?.close(); holder = null; });

test('starting on a port that is taken throws the plain port error', async () => {
  const port = await new Promise<number>((resolve) => {
    holder = createServer();
    holder.listen({ port: 0, host: '0.0.0.0' }, () => resolve((holder!.address() as { port: number }).port));
  });
  const svc = new WebSocketService(port, { setDelegationCallback: () => {}, getConfig: () => ({}) } as never);
  let error: unknown;
  try { await svc.start(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(PortUnavailableError);
  expect((error as Error).message).toContain(`Port ${port} is already in use`);
});
