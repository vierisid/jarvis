/**
 * A stand-in for the collab engine, for tests.
 *
 * It speaks as the real engine does (one JSON message a line on its standard
 * input and output for `mcp`, one JSON document for a read) and does only
 * what a test needs. What it says is shaped after the real engine, version
 * 0.0.0 of 18 November 2026: the tool names, a dialog with one field
 * `choice`, prose for an answer.
 *
 * Run as a program: the first word is `mcp` or a read.
 *
 * What it keeps, it keeps in `$COLLAB_DATA_DIR/stand-in.json`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const words = process.argv.slice(2);
const dataDir = process.env.COLLAB_DATA_DIR ?? '';
const file = join(dataDir, 'stand-in.json');

interface Kept { policy: { message: string; task: string }; env: Record<string, string> }
function kept(): Kept {
  if (dataDir && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Kept;
  return { policy: { message: 'allow', task: 'ask' }, env: {} };
}
function keep(value: Kept): void { if (dataDir) writeFileSync(file, JSON.stringify(value)); }

function print(document: unknown): void { process.stdout.write(`${JSON.stringify(document, null, 2)}\n`); }

if (words[0] !== 'mcp') {
  // A read. The real program prints notes on its other output; so does this one.
  process.stderr.write('collab: not logged in; showing the local inbox only\n');
  if (!words.includes('--json')) { print({ error: { code: 'usage', message: 'the stand-in only prints documents' } }); process.exit(2); }
  if (words[0] === 'status') print({ version: '0.0.0', account: { loggedIn: false }, words, env: { dataDir, channels: process.env.COLLAB_CHANNELS ?? null, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null } });
  else if (words[0] === 'contacts') print({ contacts: [], trustControlPlaneVouches: false });
  else if (words[0] === 'inbox') print({ items: [], unread: 0, words });
  else if (words[0] === 'tasks') print({ tasks: [], words });
  else { print({ error: { code: 'usage', message: 'unknown' } }); process.exit(2); }
  process.exit(0);
}

let next = 1000;
const waiting = new Map<number, (result: Record<string, unknown>) => void>();
function send(message: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
function ask(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = next++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
const text = (value: string, failed = false): Record<string, unknown> => ({ content: [{ type: 'text', text: value }], ...(failed ? { isError: true } : {}) });

const TOOLS = ['account', 'contacts', 'send_message', 'send_task', 'inbox', 'open_task', 'task_update', 'task_control', 'connect', 'threads', 'policy'];

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'account') return text('Server: not configured\nLogged in: no\nConnection: idle\nDialogs: available');
  if (name === 'policy' && args.action === 'show') { const now = kept(); return text(`Rules:\n- default message: ${now.policy.message}\n- default task: ${now.policy.task}`); }
  if (name === 'policy' && args.action === 'set') {
    const kind = args.kind === 'task' ? 'task' : 'message';
    const answer = await ask('elicitation/create', {
      mode: 'form',
      message: `collab: change a permission? Proposed by the agent; confirm only if you asked for it.\nChange: ${kind}s from every contact (the default)\nNew: ${String(args.effect)}.`,
      requestedSchema: { type: 'object', properties: { choice: { type: 'string', title: 'Decision', oneOf: [{ const: 'confirm', title: 'Confirm the change' }, { const: 'reject', title: 'Reject' }] } }, required: ['choice'] },
    });
    const content = (answer.content ?? {}) as Record<string, unknown>;
    if (answer.action === 'accept' && content.choice === 'confirm') {
      const now = kept();
      now.policy[kind] = String(args.effect);
      keep(now);
      return text('The policy was changed.');
    }
    if (answer.action === 'accept' || answer.action === 'decline') return text('The user rejected the change; nothing changed.');
    return text('The user closed the dialog; nothing changed.');
  }
  if (name === 'account_page') {
    // Not a tool of the real engine: lets a test see a dialog that is a web page.
    const answer = await ask('elicitation/create', { mode: 'url', message: 'Sign in to collab at the server in your browser.', url: 'https://collab.invalid/authorize?state=1', elicitationId: 'page-1' });
    return text(`page: ${String(answer.action)}`);
  }
  if (name === '_model') {
    // Not a tool of the real engine: asks the brain to lend it a model, which the brain must refuse.
    const answer = await ask('sampling/createMessage', { messages: [], maxTokens: 1 });
    return text(`model: ${JSON.stringify(answer)}`);
  }
  if (name === '_arrive') { send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'collab: a new message arrived for this session.', meta: { kind: 'message', item_id: String(args.item ?? 'item-1'), needs_approval: 'false' } } }); return text('told'); }
  if (name === '_fall') { process.exit(7); }
  return text(`Error (unknown_tool): ${name}`, true);
}

let rest = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  rest += chunk;
  for (;;) {
    const end = rest.indexOf('\n');
    if (end < 0) break;
    const line = rest.slice(0, end).trim();
    rest = rest.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.method !== 'string') {
      const answer = waiting.get(message.id as number);
      waiting.delete(message.id as number);
      answer?.((message.result ?? { error: message.error }) as Record<string, unknown>);
      continue;
    }
    if (message.id === undefined) continue;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } }, serverInfo: { name: 'collab', version: '0.0.0' }, hello: params } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })) } });
    } else if (message.method === 'tools/call') {
      const id = message.id;
      void call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>).then((result) => send({ jsonrpc: '2.0', id, result }));
    } else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported' } });
  }
});
process.stdin.on('end', () => process.exit(0));
