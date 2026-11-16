import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { assertPortFree, isAddressInUseError, PortUnavailableError, portInUseMessage, portNotAllowedMessage, probePort } from './port-check.ts';

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

test('the busy-port message never sends the owner to jarvis stop, which would signal the other program', () => {
  // The starting Jarvis holds its data folder lock when this is printed, so
  // the listener is not a Jarvis for this folder, and a lockless `jarvis stop`
  // kills whatever listens on the port.
  const message = portInUseMessage(3142, 3143);
  expect(message).not.toContain('jarvis stop');
  expect(message).toContain(process.platform === 'win32' ? 'netstat -ano | findstr :3142' : 'lsof -nP -iTCP:3142 -sTCP:LISTEN');
  expect(message).toContain('jarvis start --port 3143');
});

test('a suggested port stays inside 1..65535', () => {
  expect(portInUseMessage(65535, null)).toContain('jarvis start --port 65534');
  expect(portInUseMessage(65535, null)).not.toContain('65536');
  expect(portInUseMessage(4000, null)).toContain('jarvis start --port 4001');
});

test('a refused port above 1023 is not told to use a port above 1023', () => {
  expect(portNotAllowedMessage(80)).toContain('above 1023');
  expect(portNotAllowedMessage(5000)).not.toContain('above 1023');
  expect(portNotAllowedMessage(3142)).toContain('--port 3143');
});
