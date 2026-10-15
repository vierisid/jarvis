import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterviewSession } from '../../daemon/onboarding-interviewer.ts';
import { createInterviewSessionProvider, createSettingsInterviewStore } from './index.ts';
import { createInterviewClient } from './client.ts';
import { createInterviewSocketTransport, createInterviewTransportHandler } from './transport.ts';
import type { PreparedTurn } from './types.ts';

test('real loopback socket cut after acceptance, reconnect, and retry produce one answer and opening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-interview-ws-')), db = new Database(join(dir, 'vault.sqlite'));
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  let release!: () => void, accepted!: () => void;
  const blocked = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { accepted = r; });
  const turns: (string | null)[] = [], writes: string[] = [], sockets: WebSocket[] = [];
  const provider = createInterviewSessionProvider({ enabled: true, authorize: () => ({ actorId: 'fixture', projectId: 'fixture' }),
    store: createSettingsInterviewStore(() => db), interviewer: { create: createInterviewSession, async prepare({ session, answer }) {
      turns.push(answer);
      if (answer !== null) { accepted(); await blocked; session.messages.push({ role: 'user', content: answer }); }
      session.turnCount++; session.messages.push({ role: 'assistant', content: 'Fixture reply' });
      return { session, result: { assistantText: 'Fixture reply', done: false, factsRecorded: 0 }, facts: [] } satisfies PreparedTurn;
    } }, profile: { capability: 'interview-profile.v1', async commit(input) { writes.push(input.attemptId); return { confirmedFactIds: [] }; } } });
  const handle = createInterviewTransportHandler(provider);
  let completed!: () => void; const complete = new Promise<void>(r => { completed = r; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('fixture only'); },
    websocket: { async message(ws, value) { const envelope = JSON.parse(String(value)); const reply = await handle({}, envelope);
      if (reply) ws.send(JSON.stringify(reply)); if (envelope.command.type === 'answer') completed(); } },
  });
  const values = new Map<string, string>(), storage = { getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); } };
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
    return socket;
  };
  try {
    const firstSocket = await connect();
    let client = createInterviewClient({ storage, storageKey: 'fixture/fixture/tab', send: createInterviewSocketTransport(firstSocket) });
    await client.connect(); client.setDraft('Original typed answer'); const sent = client.submit(); await started;
    firstSocket.close(); await sent; client.setDraft('New draft survives'); client.dispose();
    const secondSocket = await connect();
    client = createInterviewClient({ storage, storageKey: 'fixture/fixture/tab', send: createInterviewSocketTransport(secondSocket) });
    await client.connect(); expect(client.state().snapshot?.phase).toBe('thinking');
    await client.retry(); // Same accepted request while old worker still runs.
    release(); await complete; await client.refresh();
    expect(client.state().snapshot?.phase).toBe('ready');
    expect(client.state().draft.text).toBe('New draft survives'); expect(client.state().pendingAnswer).toBeNull();
    expect(turns).toEqual([null, 'Original typed answer']); expect(new Set(writes).size).toBe(2);
    expect(client.state().snapshot?.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(client.state().snapshot?.messages.filter(m => m.role === 'assistant')).toHaveLength(2);
    client.dispose();
  } finally { release(); for (const socket of sockets) socket.close(); server.stop(true); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
