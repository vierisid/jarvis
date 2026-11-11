import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { assertPortFree, isAddressInUseError, PortUnavailableError, probePort } from './port-check.ts';

let holder: Server | null = null;
afterEach(() => { holder?.close(); holder = null; });
const hold = (): Promise<number> => new Promise((resolve) => {
  holder = createServer();
  holder.listen({ port: 0, host: '0.0.0.0' }, () => resolve((holder!.address() as { port: number }).port));
});

test('a free port passes and a busy one names the port and how to pick another', async () => {
  const port = await hold();
  expect(await probePort(port)).toBe('in_use');
  let error: unknown;
  try { await assertPortFree(port); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(PortUnavailableError);
  const message = (error as Error).message;
  expect(message).toContain(`Port ${port} is already in use`);
  expect(message).toContain('--port');
  expect(message).toContain('JARVIS_PORT');
  expect(message).not.toMatch(/EADDRINUSE|at .*\.ts/);
  holder!.close(); holder = null;
  await assertPortFree(port);
});

test('recognises Bun\'s own address-in-use failures', () => {
  expect(isAddressInUseError(new Error('Failed to start server. Is port 3244 in use?'))).toBe(true);
  expect(isAddressInUseError(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(true);
  expect(isAddressInUseError(new Error('something else'))).toBe(false);
});
