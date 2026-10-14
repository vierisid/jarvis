import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
import { AgentTaskManager } from '../../agents/task-manager.ts';
import { AuthorityEngine } from '../../authority/engine.ts';
import { AuditTrail } from '../../authority/audit.ts';
import { ApprovalManager } from '../../authority/approval.ts';
import type { RoleDefinition } from '../../roles/types.ts';
import type { LLMManager } from '../../llm/manager.ts';
import { forCard } from '../../util/card-text.ts';
import {
  createManageAgentsTool, manageAgentsGate, SPECIALIST_ID_MAX_CHARS, startPersistentAgent, type AgentToolDeps,
} from './agents.ts';
import { createDelegateTool, delegateTaskGate } from './delegate.ts';

/**
 * #1019: the specialist a card names is the one that runs. Cards show the id
 * through `forCard` (invisible characters dropped, cut to 60), while the run
 * looked the specialist up by the raw id, so the two could differ. An id the
 * card cannot show exactly is refused wherever an agent is started.
 */

function role(id: string): RoleDefinition {
  return { id, name: id.toUpperCase(), description: 'A role.', responsibilities: ['Things'], autonomous_actions: [],
    approval_required: [], tools: [], authority_level: 5 } as unknown as RoleDefinition;
}

const PLAIN = 'researcher';
/** Renders as `researcher` on a card: the zero-width space is dropped. */
const HIDDEN = 're\u200Bsearcher';
/** Two ids sharing their first 57 characters: a 60-character card shows both as the same prefix and "...". */
const LONG_A = `${'a'.repeat(57)}-one`;
const LONG_B = `${'a'.repeat(57)}-two`;

function setup() {
  const orch = new AgentOrchestrator();
  orch.setAuthorityEngine(new AuthorityEngine({ default_level: 5, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal' }));
  orch.setApprovalManager(new ApprovalManager());
  orch.setAuditTrail(new AuditTrail());
  orch.createPrimary({ ...role('pa'), tools: ['delegation'] } as RoleDefinition);
  const specialists = new Map([PLAIN, HIDDEN, LONG_A, LONG_B].map((id) => [id, role(id)]));
  const llm = { chatTier: async () => ({ content: 'done', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) } as unknown as LLMManager;
  const deps: AgentToolDeps = { orchestrator: orch, llmManager: llm, specialists, taskManager: new AgentTaskManager() };
  const spawned = () => orch.getAllAgents().map((a) => a.agent.role.id).filter((id) => id !== 'pa');
  return { orch, deps, specialists, llm, spawned };
}

describe('what runs is the specialist the card named (#1019)', () => {
  beforeEach(() => initDatabase(':memory:', { quiet: true }));
  afterEach(() => closeDb());

  test('the premise: the card shows the hidden and the plain id the same, and the long ids the same', () => {
    expect(manageAgentsGate({ action: 'spawn', specialist: HIDDEN })!.intent).toBe(manageAgentsGate({ action: 'spawn', specialist: PLAIN })!.intent);
    expect(manageAgentsGate({ action: 'spawn', specialist: LONG_A })!.intent).toBe(manageAgentsGate({ action: 'spawn', specialist: LONG_B })!.intent);
    expect(delegateTaskGate({ specialist: HIDDEN }).intent).toBe(delegateTaskGate({ specialist: PLAIN }).intent);
  });

  test('a spawn naming an id with an invisible character is refused, not started as another role', async () => {
    const s = setup();
    await expect(startPersistentAgent(s.deps, { specialist: HIDDEN })).rejects.toThrow('cannot show');
    expect(s.spawned()).toEqual([]);
  });

  test('a spawn naming an id too long for the card to show whole is refused', async () => {
    const s = setup();
    await expect(startPersistentAgent(s.deps, { specialist: LONG_B })).rejects.toThrow('cannot show');
    expect(s.spawned()).toEqual([]);
  });

  test('manage_agents and delegate_task refuse them too', async () => {
    const s = setup();
    const manage = createManageAgentsTool(s.deps);
    const delegate = createDelegateTool({ orchestrator: s.orch, llmManager: s.llm, specialists: s.specialists });
    expect(String(await manage.execute({ action: 'spawn', specialist: HIDDEN }))).toContain('cannot show');
    expect(String(await delegate.execute({ specialist: LONG_A, task: 'look', context: '' }))).toContain('cannot show');
    expect(s.spawned()).toEqual([]);
  });

  test('an id that is no specialist at all still gets the list of those that are', async () => {
    const s = setup();
    const manage = createManageAgentsTool(s.deps);
    const delegate = createDelegateTool({ orchestrator: s.orch, llmManager: s.llm, specialists: s.specialists });
    for (const reply of [await manage.execute({ action: 'spawn', specialist: 'researcher ' }),
      await delegate.execute({ specialist: 'x'.repeat(80), task: 'look', context: '' })]) {
      expect(String(reply)).toContain('Unknown specialist');
      expect(String(reply)).toContain(`Available: ${PLAIN}`);
    }
  });

  test('the refusal shows the id escaped, not with its invisible characters', async () => {
    const s = setup();
    const reply = String(await createManageAgentsTool(s.deps).execute({ action: 'spawn', specialist: HIDDEN }));
    expect(reply).toContain('re\\u200Bsearcher');
    expect(reply).not.toContain('\u200B');
  });

  test('an id the card shows whole still starts, at exactly the card\'s budget', async () => {
    const s = setup();
    const edge = 'b'.repeat(SPECIALIST_ID_MAX_CHARS);
    s.specialists.set(edge, role(edge));
    expect(forCard(edge, SPECIALIST_ID_MAX_CHARS)).toBe(edge);
    await startPersistentAgent(s.deps, { specialist: PLAIN });
    await startPersistentAgent(s.deps, { specialist: edge });
    expect(s.spawned()).toEqual([PLAIN, edge]);
  });

  test('the cards cut the id at the same budget the check uses', () => {
    const over = 'c'.repeat(SPECIALIST_ID_MAX_CHARS + 1);
    expect(manageAgentsGate({ action: 'spawn', specialist: over })!.intent).toContain(`${'c'.repeat(SPECIALIST_ID_MAX_CHARS - 3)}...`);
    expect(delegateTaskGate({ specialist: over }).intent).toContain(`${'c'.repeat(SPECIALIST_ID_MAX_CHARS - 3)}...`);
  });
});
