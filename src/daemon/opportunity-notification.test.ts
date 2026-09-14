import { expect, test } from 'bun:test';
import { WebSocketServer, type WSMessage } from '../comms/websocket.ts';
import type { Suggestion } from '../awareness/types.ts';
import { deliverOpportunityNotification } from './opportunity-notification.ts';

const suggestion: Suggestion = { id: 'stable-opportunity', type: 'automation', title: 'Review invoices',
  body: 'Three observed episodes.', triggerCaptureId: 'capture-1', context: {} };

test('connected but dropping sockets and failed channels do not count as delivery', async () => {
  const messages: WSMessage[] = [];
  let nativeCalls = 0;
  let externalText = '';
  const result = await deliverOpportunityNotification(suggestion,
    { broadcastWithReceipt: m => { messages.push(m); return 0; } },
    { getManager: () => ({ listChannels: () => ['telegram'] }),
      tryBroadcastToChannels: async (channels, text) => {
        expect(channels).toEqual(['telegram']);
        externalText = text;
        return { delivered: [], failed: [{ channel: 'telegram', error: 'offline' }] };
      } },
    async () => { nativeCalls++; return false; });
  expect(result).toBeNull();
  expect(nativeCalls).toBe(1);
  expect(externalText).toContain(suggestion.id);
  expect(messages[0]!.payload).toMatchObject({ event: { data: { id: suggestion.id } } });
  expect(messages[1]!.payload).toMatchObject({ opportunityId: suggestion.id });
});

test.each(['telegram', 'desktop'])('%s acceptance establishes delivery', async transport => {
  const result = await deliverOpportunityNotification(suggestion, { broadcastWithReceipt: () => 0 },
    { getManager: () => ({ listChannels: () => ['telegram'] }),
      tryBroadcastToChannels: async () => ({ delivered: transport === 'telegram' ? ['telegram'] : [], failed: [] }) },
    async () => { expect(transport).toBe('desktop'); return true; });
  expect(result).toBe(transport);
});

test('WebSocket receipt delivers the same opportunity ID to a real client', async () => {
  const server = new WebSocketServer(0);
  server.setInsecureOpenAccess(true);
  server.start();
  let client: WebSocket | undefined;
  try {
    const received: WSMessage[] = [];
    const port = (server as unknown as { server: { port: number } }).server.port;
    client = new WebSocket(`ws://localhost:${port}/ws`);
    client.addEventListener('message', event => { received.push(JSON.parse(String(event.data))); });
    await new Promise<void>((resolve, reject) => {
      client!.addEventListener('open', () => resolve(), { once: true });
      client!.addEventListener('error', reject, { once: true });
    });
    const receipt = await deliverOpportunityNotification(suggestion, server,
      { getManager: () => ({ listChannels: () => [] }), tryBroadcastToChannels: async () => { throw new Error('Must use the socket'); } },
      async () => { throw new Error('Must use the socket'); });
    for (let i = 0; i < 50 && !received.some(m => m.type === 'chat'); i++) await Bun.sleep(10);
    expect(receipt).toBe('websocket');
    expect(received.find(m => m.type === 'notification')?.payload).toMatchObject({ event: { data: { id: suggestion.id } } });
    expect(received.find(m => m.type === 'chat')?.payload).toMatchObject({ opportunityId: suggestion.id });
  } finally { client?.close(); server.stop(); }
});

test('WebSocket receipts exclude dropped frames and include queued frames', () => {
  const server = new WebSocketServer(0);
  // Isolate Bun's send statuses, including a closed socket that has not yet
  // been removed by its close handler and a socket under backpressure.
  const clients = (server as unknown as { clients: Set<unknown> }).clients;
  clients.add({ send: () => 0 });
  expect(server.broadcastWithReceipt({ type: 'chat', payload: {}, timestamp: 0 })).toBe(0);
  clients.add({ send: () => -1 });
  clients.add({ send: () => 30 });
  expect(server.broadcastWithReceipt({ type: 'chat', payload: {}, timestamp: 0 })).toBe(2);
});

test.each([0, 1])('native sender exit %i determines its receipt', async code => {
  // Separate process isolates notification detection and Bun mocks from other suites.
  const script = `
    import { sendDesktopNotificationWithReceipt } from ${JSON.stringify(new URL('../comms/desktop-notify.ts', import.meta.url).href)};
    Bun.spawnSync = () => ({ exitCode: 0 });
    Bun.spawn = () => ({ exited: Promise.resolve(${code}), kill() {} });
    console.log('RESULT:' + await sendDesktopNotificationWithReceipt('Title', 'Body'));
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, errors }).toEqual({ exit: 0, errors: '' });
  expect(output.trim().split('RESULT:')[1]).toBe(String(code === 0));
});
