import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, initWorkflowDb } from '../../workflows/db/index';
import { getWorkflowComposition } from '../../workflows/db/repos/workflow-composition';
import { PieceCatalog } from '../../workflows/runtime/piece-catalog';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import type { JobContract } from './job-contract';
import { createManageWorkflowTool } from './manage-workflow';
import { composePersistedFlow } from './persisted-workflow-composer';
import { composeFlow, type ComposerChatMessage, type ComposerChatReply, type ComposerLlmClient } from './workflow-composer';
import { UNTRUSTED_OPEN } from '../../roles/untrusted';

const field = (name: string, type: string, required: boolean) => ({ name, label: name, type, required });
const gmailAction = (name: string) => ({ name, displayName: name, description: `Gmail ${name}.`, requireAuth: true,
  inputSchema: { fields: [field('receiver', 'json', true), field('subject', 'string', true), field('body', 'long_text', true)] } });
const catalog = () => new PieceCatalog([...sampleCatalog().list(), { name: '@activepieces/piece-gmail', displayName: 'Gmail',
  description: 'Send and draft email.', auth: { type: 'OAUTH2', description: 'Gmail connection' },
  actions: { send_email: gmailAction('send_email'), gmail_create_draft: gmailAction('gmail_create_draft') } } as any]);

const request = { name: 'Invoice reminder', description: 'Every Monday, draft the invoice reminder to ana@example.com and tell me on the dashboard. Never send email.' };
const contract: JobContract = {
  outputs: [{ piece: 'gmail', action: 'gmail_create_draft', target: { receiver: ['ana@example.com'] } }, { notify: { channels: ['dashboard'] } }],
  recipients: ['ana@example.com', 'dashboard'], forbidden: { effects: ['send_email'] }, review: ['The reminder names the overdue invoices.'],
};
const gmail = (name: string, action: string, next?: object) => ({ name, type: 'PIECE',
  settings: { pieceName: '@activepieces/piece-gmail', actionName: action, input: { receiver: ['ana@example.com'], subject: 'Invoices', body: 'Hi Ana' } },
  ...(next ? { nextAction: next } : {}) });
const notify = { name: 'tell', type: 'PIECE', settings: { pieceName: 'jarvis-notify', actionName: 'notify', input: { message: 'Drafted', channels: ['dashboard'] } } };
const flow = (first: object) => ({ displayName: request.name, trigger: { name: 'trigger', type: 'EMPTY', nextAction: first } });
const kept = flow(gmail('draft', 'gmail_create_draft', notify));
/** Structurally valid, but it sends the email the job forbids instead of drafting it. */
const sends = flow(gmail('send', 'send_email', notify));
const providerDown = () => { throw new Error('ECONNREFUSED: the provider is unreachable'); };

describe('the composer holds a graph to the job contract', () => {
  test('a valid graph that breaks the contract goes back for repair with focused errors and the contract; the kept one passes with its report', async () => {
    const prompts: string[] = [];
    const llm: ComposerLlmClient = { async chat({ prompt }) {
      prompts.push(prompt);
      return { text: JSON.stringify(prompts.length === 1 ? sends : kept) };
    } };
    const result = await composeFlow({ llm, pieceRegistry: catalog() }, { ...request, contract });
    expect(result.ok).toBe(true);
    expect(result.ok && result.contract).toEqual({ verified: expect.arrayContaining(['sends nothing beyond the requested outputs',
      'does nothing the job forbids (send_email)']), review: ['The reminder names the overdue invoices.'] });
    expect(prompts[1]).toContain('job contract: step "send" would send email, which the job forbids');
    expect(prompts[1]).toContain('job contract: step "send" sends a message the job did not ask for');
    // The repair prompt still carries the contract as part of the job specification.
    const context = JSON.parse(prompts[1]!.slice(prompts[1]!.indexOf('Composition context (JSON):\n') + 28));
    expect(context.jobSpecification.contract).toEqual(contract);
  });

  test('a repair cannot drop a requirement: every candidate is checked against the same contract', async () => {
    const prompts: string[] = [];
    const llm: ComposerLlmClient = { async chat({ prompt }) { prompts.push(prompt); return { text: JSON.stringify(sends) }; } };
    const result = await composeFlow({ llm, pieceRegistry: catalog(), maxAttempts: 3 }, { ...request, contract });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toContain('job contract: step "send" would send email, which the job forbids');
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt).toContain('"forbidden":{"effects":["send_email"]}');
  });

  test('a provider failure after a contract violation is a failure, never an abstention', async () => {
    let calls = 0;
    const oneShot: ComposerLlmClient = { async chat() { return ++calls === 1 ? { text: JSON.stringify(sends) } : providerDown(); } };
    const plain = await composeFlow({ llm: oneShot, pieceRegistry: catalog() }, { ...request, contract });
    expect(plain).toMatchObject({ ok: false, errors: [expect.stringMatching(/^LLM call failed/)] });
    expect(!plain.ok && plain.errorCode).toBeTruthy();
    expect(!plain.ok && plain.blocked).toBeUndefined();

    let turns = 0;
    const loop = (second: () => ComposerChatReply): ComposerLlmClient => ({
      async chat() { throw new Error('unexpected fallback'); },
      async chatTools() { return ++turns % 2 === 1 ? { content: '', tool_calls: [{ id: 'a', name: 'submit_flow', arguments: sends as any }] } : second(); },
    });
    const failed = await composeFlow({ llm: loop(providerDown), pieceRegistry: catalog() }, { ...request, contract });
    expect(failed).toMatchObject({ ok: false, errors: [expect.stringMatching(/^LLM call failed/)] });
    expect(!failed.ok && failed.blocked).toBeUndefined();
    // Only an explicit report_blocked is an abstention.
    const reported = await composeFlow({ llm: loop(() => ({ content: '', tool_calls: [{ id: 'b', name: 'report_blocked',
      arguments: { reason: 'Drafting needs a Gmail connection' } }] })), pieceRegistry: catalog() }, { ...request, contract });
    expect(reported).toMatchObject({ ok: false, blocked: true, errors: ['Drafting needs a Gmail connection'] });
    expect(!reported.ok && reported.errorCode).toBeUndefined();
  });

  test('the tool loop holds inline JSON to the contract too', async () => {
    const seen: ComposerChatMessage[][] = [];
    const replies: ComposerChatReply[] = [
      { content: '', tool_calls: [{ id: 'a', name: 'submit_flow', arguments: sends as any }] },
      { content: JSON.stringify(sends), tool_calls: [] },
      { content: JSON.stringify(kept), tool_calls: [] },
    ];
    const llm: ComposerLlmClient = {
      async chat() { throw new Error('unexpected fallback'); },
      async chatTools(messages) { seen.push(structuredClone(messages)); return replies[seen.length - 1]!; },
    };
    const result = await composeFlow({ llm, pieceRegistry: catalog() }, { ...request, contract });
    expect(result.ok && result.flow.trigger.nextAction?.settings?.actionName).toBe('gmail_create_draft');
    expect(result.ok && result.contract?.review).toEqual(['The reminder names the overdue invoices.']);
    // The inline candidate that sent was refused with the contract's own words, and the model was asked again.
    expect(seen).toHaveLength(3);
    expect(seen[2]!.at(-1)!.content).toContain('Your inline JSON failed validation.');
    expect(seen[2]!.at(-1)!.content).toContain('would send email, which the job forbids');
  });

  test('a contract that cannot be met fails before any provider request', async () => {
    let calls = 0;
    const llm: ComposerLlmClient = { async chat() { calls++; return { text: JSON.stringify(kept) }; } };
    const result = await composeFlow({ llm, pieceRegistry: catalog() },
      { ...request, contract: { outputs: [{ notify: { channels: ['telegram'] } }], recipients: ['dashboard'] } });
    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('Job contract cannot be met')] });
    expect(calls).toBe(0);
  });

  test('without a contract nothing changes', async () => {
    const llm: ComposerLlmClient = { async chat() { return { text: JSON.stringify(sends) }; } };
    const result = await composeFlow({ llm, pieceRegistry: catalog() }, request);
    expect(result.ok).toBe(true);
    expect(result.ok && result.contract).toBeUndefined();
  });
});

describe('production composition', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jarvis-job-contract-'));
    initWorkflowDb(join(directory, 'test.db'));
  });
  afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

  test('the journal keeps the contract with the job, as the caller gave it', async () => {
    const llm: ComposerLlmClient = { async chat() { return { text: JSON.stringify(kept) }; } };
    const result = await composePersistedFlow({ llm, pieceRegistry: catalog() }, { ...request, contract });
    expect(result.ok).toBe(true);
    expect(getWorkflowComposition(result.compositionRecordId)!.specification.contract).toEqual(contract);
  });

  test('the chat tool passes a stated contract and returns what to confirm; an unmeetable one is refused', async () => {
    const parse = (returned: string) => {
      const lines = returned.split('\n');
      return JSON.parse(lines[1]?.startsWith(UNTRUSTED_OPEN) ? lines.slice(2, -1).join('\n') : returned);
    };
    const llm: ComposerLlmClient = { async chat() { return { text: JSON.stringify(kept) }; } };
    const tool = createManageWorkflowTool({ llm, pieceRegistry: catalog() });
    const ok = parse(await tool.execute({ action: 'compose', ...request, contract }) as string);
    expect(ok).toMatchObject({ ok: true, contract: { review: ['The reminder names the overdue invoices.'] } });
    const refused = parse(await tool.execute({ action: 'compose', name: 'Another reminder', description: request.description,
      contract: { forbidden: { effects: ['send_fax'] } } }) as string);
    expect(refused).toMatchObject({ ok: false, errors: [expect.stringContaining('unknown effect send_fax')] });
    // `create` with a description reroutes to compose, and keeps the contract.
    const rerouted = parse(await tool.execute({ action: 'create', name: 'A third reminder', description: request.description,
      contract: { forbidden: { effects: ['send_fax'] } } }) as string);
    expect(rerouted).toMatchObject({ ok: false, routedFrom: 'create', errors: [expect.stringContaining('unknown effect send_fax')] });
  });
});
