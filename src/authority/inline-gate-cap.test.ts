import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { ApprovalManager } from './approval.ts';
import { AuditTrail } from './audit.ts';
import { DeferredExecutor } from './deferred-executor.ts';
import { AuthorityEngine } from './engine.ts';
import { ToolRegistry } from '../actions/tools/registry.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import type { RoleDefinition } from '../roles/types.ts';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../roles/untrusted.ts';

// #828: the inline approval gate framed an approved tool's plain result with no
// MAX_TOOL_RESULT_CHARS cut, while the ungated path caps before framing. The
// tools that take a card -- an approved browser_navigate, desktop_snapshot --
// are the ones whose results are page- or screen-sized.

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

/** The orchestrator's own cap. Not exported; restated, and pinned below. */
const CAP = 6000;

/** Run a name-framed tool through the inline gate, approve it, and return what the model gets. */
async function throughInlineGate(execute: () => Promise<unknown>): Promise<string> {
  return String(await throughInlineGateRaw(execute));
}

/** As `throughInlineGate`, but what the model gets as it is: blocks stay blocks. */
async function throughInlineGateRaw(execute: () => Promise<unknown>): Promise<unknown> {
  const role = { id: 'personal-assistant', name: 'PA', description: 't', responsibilities: [], tools: ['desktop'],
    authority_level: 10 } as unknown as RoleDefinition;
  const approvals = new ApprovalManager();
  const audit = new AuditTrail();
  const reg = new ToolRegistry();
  // desktop_launch_app is in UNTRUSTED_TOOL_NAMES, so its result is framed.
  reg.register({ name: 'desktop_launch_app', category: 'desktop', description: 'synthetic', parameters: {}, execute });
  const orch = new AgentOrchestrator();
  orch.setToolRegistry(reg);
  orch.setAuthorityEngine(new AuthorityEngine({ default_level: 10, governed_categories: ['read_data', 'control_app'],
    overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
  orch.setApprovalManager(approvals);
  orch.setAuditTrail(audit);
  const ex = new DeferredExecutor(approvals, audit);
  ex.setToolRegistry(reg);
  orch.setDeferredExecutor(ex);
  orch.createPrimary(role);
  type Exec = { executeTool: (tc: { id: string; name: string; arguments: Record<string, unknown> }, signal?: AbortSignal, taint?: Set<string>) => Promise<unknown> };
  const pending = (orch as unknown as Exec).executeTool({ id: 'call', name: 'desktop_launch_app', arguments: {} }, undefined, new Set());
  let card = approvals.getPending()[0];
  for (let i = 0; !card && i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    card = approvals.getPending()[0];
  }
  expect(card?.tool_name).toBe('desktop_launch_app');
  approvals.approve(card!.id, 'dashboard');
  return pending;
}

/** One whole block: opened once, closed once, nothing after the close. */
function expectOneWholeBlock(result: string): void {
  expect(result.split(UNTRUSTED_OPEN).length).toBe(2);
  expect(result.split(UNTRUSTED_CLOSE).length).toBe(2);
  expect(result.trimEnd().endsWith(UNTRUSTED_CLOSE)).toBe(true);
}

describe('the inline gate caps an approved result before framing it (#828)', () => {
  test('a page-sized plain result is cut to the cap, and the frame is drawn around the cut', async () => {
    const huge = 'p'.repeat(50_000);
    const result = await throughInlineGate(async () => huge);
    expect(result).toContain('(truncated, was 50000 chars)');
    // The payload kept is exactly the cap: not the whole page, and not a
    // shorter cut made after the frame was drawn.
    expect(result.split('p'.repeat(CAP + 1)).length).toBe(1);
    expect(result).toContain('p'.repeat(CAP));
    expectOneWholeBlock(result);
    // Bounded: the cap plus the frame and the note, nowhere near the page.
    expect(result.length).toBeLessThan(CAP + 2000);
  });

  test('a failure that is not outside content is capped too', async () => {
    // `failureIsOutsideContent` unset, so the error string takes the plain
    // branch -- a thrown message can carry a remote stderr tail of any length.
    const result = await throughInlineGate(async () => { throw new Error('e'.repeat(30_000)); });
    expect(result).toContain('(truncated, was ');
    expect(result.length).toBeLessThan(CAP + 2000);
    expectOneWholeBlock(result);
  });

  test('a result under the cap is framed whole and unchanged', async () => {
    // Regression guard, passes with and without #828.
    const small = 'q'.repeat(CAP);
    const result = await throughInlineGate(async () => small);
    expect(result).toContain(small);
    expect(result).not.toContain('truncated');
    expectOneWholeBlock(result);
  });
});

describe('the inline gate caps an approved multi-modal result before framing it (#876)', () => {
  const IMAGE = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AA==' } };

  test('a page-sized text block is cut to the cap inside one whole frame, and the image is kept', async () => {
    const out = await throughInlineGateRaw(async () => ({ content: [{ type: 'text', text: 'p'.repeat(50_000) }, IMAGE] }));
    const blocks = out as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual(IMAGE);
    const text = blocks[0]!.text!;
    expect(text).toContain('(truncated, was 50000 chars)');
    expect(text.split('p'.repeat(CAP + 1)).length).toBe(1);
    expect(text).toContain('p'.repeat(CAP));
    expectOneWholeBlock(text);
    expect(text.length).toBeLessThan(CAP + 2000);
  });

  test('text under the cap is framed whole and unchanged', async () => {
    // Regression guard, passes with and without #876.
    const out = await throughInlineGateRaw(async () => ({ content: [{ type: 'text', text: 'q'.repeat(CAP) }, IMAGE] }));
    const text = (out as Array<{ type: string; text?: string }>)[0]!.text!;
    expect(text).toContain('q'.repeat(CAP));
    expect(text).not.toContain('truncated');
    expectOneWholeBlock(text);
  });
});
