import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import { AuthorityEngine } from './engine.ts';
import { ToolRegistry, type ToolResult } from '../actions/tools/registry.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import type { RoleDefinition } from '../roles/types.ts';
import { UNTRUSTED_OPEN } from '../roles/untrusted.ts';

// #709: an approved call that returns a picture. The executor's single string
// feeds the receipt column, the dashboard notification, the execute route and
// the inline gate; only the last has a model behind it, and before #709 every
// one of them got `JSON.stringify` of the ToolResult -- base64 and all.

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

// Long enough that a prefix of it is unmistakable in a receipt or a string.
const PIXELS = 'iVBORw0KGgo' + 'A'.repeat(40_000);
const screenshot = (): ToolResult => ({
  content: [
    { type: 'text', text: 'Desktop screenshot captured.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXELS } },
  ],
});

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({ name: 'desktop_screenshot', category: 'desktop', description: 'synthetic', parameters: {}, execute: async () => screenshot() });
  return r;
}

describe('an approved call that returns an image (#709)', () => {
  test('the receipt names the image instead of storing its base64, and the blocks come back separately', async () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'desktop_screenshot', toolArguments: {},
      actionCategory: 'read_data', urgency: 'normal', reason: 'test', context: '' });
    mgr.approve(req.id, 'dashboard');
    const ex = new DeferredExecutor(mgr, new AuditTrail());
    ex.setToolRegistry(registry());
    const notified: string[] = [];
    ex.setResultCallback((_id, _req, result) => notified.push(result));

    const receipt = await ex.executeApprovedWithReceipt(req.id);

    expect(receipt.result).not.toContain('iVBORw0KGgo');
    expect(receipt.result).toContain('Desktop screenshot captured.');
    expect(receipt.result).toContain('[image: image/png');
    expect(receipt.content).toEqual(screenshot().content);
    const row = mgr.getRequest(req.id)!;
    expect(row.execution_outcome).toBe('committed');
    expect(row.execution_result).not.toContain('iVBORw0KGgo');
    expect(row.execution_result).toBe(receipt.result);
    expect(notified).toEqual([receipt.result]);
  });

  test('a text result is unchanged and carries no blocks', async () => {
    const mgr = new ApprovalManager();
    const req = mgr.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'read_thing', toolArguments: {},
      actionCategory: 'read_data', urgency: 'normal', reason: 'test', context: '' });
    mgr.approve(req.id, 'dashboard');
    const r = new ToolRegistry();
    r.register({ name: 'read_thing', category: 'general', description: 'synthetic', parameters: {}, execute: async () => 'plain text' });
    const ex = new DeferredExecutor(mgr, new AuditTrail());
    ex.setToolRegistry(r);
    const receipt = await ex.executeApprovedWithReceipt(req.id);
    expect(receipt.result).toBe('plain text');
    expect(receipt.content).toBeUndefined();
  });

  test('the inline gate hands the model the picture, not a string of it', async () => {
    const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['desktop'],
      authority_level: 10 } as unknown as RoleDefinition;
    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const reg = registry();
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(reg);
    // read_data governed, so the screenshot waits for a person.
    orch.setAuthorityEngine(new AuthorityEngine({ default_level: 10, governed_categories: ['read_data'], overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
    orch.setApprovalManager(approvals);
    orch.setAuditTrail(audit);
    const ex = new DeferredExecutor(approvals, audit);
    ex.setToolRegistry(reg);
    orch.setDeferredExecutor(ex);
    orch.createPrimary(role);

    type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
    const taint = new Set<string>();
    const pending = (orch as unknown as Exec).executeTool({ id: 'call', name: 'desktop_screenshot', arguments: {} }, undefined, taint);
    let card = approvals.getPending()[0];
    for (let i = 0; !card && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      card = approvals.getPending()[0];
    }
    expect(card?.tool_name).toBe('desktop_screenshot');
    approvals.approve(card!.id, 'dashboard');
    const result = await pending;

    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{ type: string; text?: string; source?: { data: string } }>;
    expect(blocks.find((b) => b.type === 'image')?.source?.data).toBe(PIXELS);
    expect(blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')).toContain('Desktop screenshot captured.');
    // A picture of the screen is outside content: the turn is tainted, exactly
    // as the ungated path taints it (TAINT_ONLY_TOOLS in roles/untrusted.ts).
    expect([...taint]).toEqual(['desktop_screenshot']);
  });

  test('the inline gate frames the text blocks of a name-framed tool, as the ungated path does', async () => {
    // desktop_snapshot is in UNTRUSTED_TOOL_NAMES, so its text is framed; a
    // multi-modal reply from it must come back framed too, not raw.
    const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['desktop'],
      authority_level: 10 } as unknown as RoleDefinition;
    const approvals = new ApprovalManager();
    const audit = new AuditTrail();
    const reg = new ToolRegistry();
    reg.register({ name: 'desktop_snapshot', category: 'desktop', description: 'synthetic', parameters: {}, execute: async () => screenshot() });
    const orch = new AgentOrchestrator();
    orch.setToolRegistry(reg);
    orch.setAuthorityEngine(new AuthorityEngine({ default_level: 10, governed_categories: ['read_data'], overrides: [],
      context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
    orch.setApprovalManager(approvals);
    orch.setAuditTrail(audit);
    const ex = new DeferredExecutor(approvals, audit);
    ex.setToolRegistry(reg);
    orch.setDeferredExecutor(ex);
    orch.createPrimary(role);
    type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
    const pending = (orch as unknown as Exec).executeTool({ id: 'call', name: 'desktop_snapshot', arguments: {} }, undefined, new Set());
    let card = approvals.getPending()[0];
    for (let i = 0; !card && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      card = approvals.getPending()[0];
    }
    approvals.approve(card!.id, 'dashboard');
    const blocks = (await pending) as Array<{ type: string; text?: string }>;
    const text = blocks.find((b) => b.type === 'text')!.text!;
    expect(text).toContain(UNTRUSTED_OPEN);
    expect(text).toContain('Desktop screenshot captured.');
  });
});
