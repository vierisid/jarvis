import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, initWorkflowDb } from '../../workflows/db';
import { createFlow, listFlows } from '../../workflows/db/repos/flow';
import { createDraftVersion, getFlowVersion, getLatestDraft } from '../../workflows/db/repos/flow-version';
import { configureWorkflowReadiness } from '../../workflows/db/repos/flow-readiness';
import { sampleCatalog } from '../../workflows/runtime/test-fixtures';
import { WORKFLOW_NAME_MAX_CHARS } from '../../workflows/api/display-name';
import { createManageWorkflowTool } from './manage-workflow';
import type { ComposerLlmClient } from './workflow-composer';

// manage_workflow holds workflow and step names to the dashboard routes' cap
// (validDisplayName in workflows/api/routes.ts).
const atCap = 'n'.repeat(WORKFLOW_NAME_MAX_CHARS);
const overCap = 'n'.repeat(WORKFLOW_NAME_MAX_CHARS + 1);
const refused = `is ${WORKFLOW_NAME_MAX_CHARS + 1} characters; the limit is ${WORKFLOW_NAME_MAX_CHARS}`;

const catalog = sampleCatalog();
const unwrap = (raw: unknown) => JSON.parse(String(raw).split('\n').slice(2, -1).join('\n'));

beforeEach(() => { initWorkflowDb(':memory:'); configureWorkflowReadiness({ pieces: catalog }); });
afterEach(() => closeWorkflowDb());

test('the cap is the one the dashboard routes use', () => {
  expect(WORKFLOW_NAME_MAX_CHARS).toBe(512);
});

describe('create', () => {
  const tool = createManageWorkflowTool({ pieceRegistry: catalog });

  test('refuses a name over the cap and saves nothing', async () => {
    await expect(tool.execute({ action: 'create', name: overCap, empty: true })).rejects.toThrow(refused);
    expect(listFlows()).toHaveLength(0);
  });

  test('accepts a name at the cap', async () => {
    expect(unwrap(await tool.execute({ action: 'create', name: atCap, empty: true })).name).toBe(atCap.slice(0, 200));
    expect(listFlows()).toHaveLength(1);
  });
});

describe('compose', () => {
  function composer(displayName: string, step: { name?: string; displayName?: string } = {}): ComposerLlmClient & { calls: number } {
    const llm = {
      calls: 0,
      async chat() {
        llm.calls++;
        return { text: JSON.stringify({ displayName, trigger: { name: 'trigger', type: 'EMPTY', settings: {},
          nextAction: { name: step.name ?? 'step_1', ...(step.displayName ? { displayName: step.displayName } : {}),
            type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: 'hi' } } } } }) };
      },
    };
    return llm;
  }

  test('refuses a name over the cap before the composer is asked', async () => {
    const llm = composer('Fine');
    const tool = createManageWorkflowTool({ llm, pieceRegistry: catalog });
    await expect(tool.execute({ action: 'compose', name: overCap, description: 'ask me something' })).rejects.toThrow(refused);
    await expect(tool.execute({ action: 'create', name: overCap, description: 'ask me something' })).rejects.toThrow(refused);
    expect(llm.calls).toBe(0);
    expect(listFlows()).toHaveLength(0);
  });

  test('refuses a composed graph whose step names are over the cap, and saves nothing', async () => {
    const byName = createManageWorkflowTool({ llm: composer('Asker', { name: overCap }), pieceRegistry: catalog });
    await expect(byName.execute({ action: 'compose', name: 'Asker', description: 'ask me something' }))
      .rejects.toThrow(`step name ${refused}`);
    const byLabel = createManageWorkflowTool({ llm: composer('Asker', { displayName: overCap }), pieceRegistry: catalog });
    await expect(byLabel.execute({ action: 'compose', name: 'Asker', description: 'ask me something' }))
      .rejects.toThrow(`step displayName ${refused}`);
    expect(listFlows()).toHaveLength(0);
  });

  test("keeps the caller's name when the composer's own is over the cap", async () => {
    const tool = createManageWorkflowTool({ llm: composer(overCap), pieceRegistry: catalog });
    const result = unwrap(await tool.execute({ action: 'compose', name: 'Asker', description: 'ask me something' }));
    expect(result.ok).toBe(true);
    expect(getLatestDraft(result.flow.id)!.displayName).toBe('Asker');
  });
});

describe('update', () => {
  const tool = createManageWorkflowTool({ pieceRegistry: catalog });
  const graph = (displayName = 'Ask') => ({ name: 'trigger', type: 'EMPTY', settings: {},
    nextAction: { name: 'ask', displayName, type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: '' } } } });

  async function draft(stepDisplayName?: string) {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Existing', trigger: graph(stepDisplayName) as any });
    const page = unwrap(await tool.execute({ action: 'get', flow: flow.id, view: 'definition' }));
    return { flow, version, base: { action: 'update', flow: flow.id, version_id: version.id, expected_revision: page.revision } };
  }

  test('refuses a workflow name over the cap, accepts one at it', async () => {
    const { version, base } = await draft();
    await expect(tool.execute({ ...base, patches: [], name: overCap })).rejects.toThrow(refused);
    expect(unwrap(await tool.execute({ ...base, patches: [], name: atCap })).changed).toBe(true);
    expect(getFlowVersion(version.id)!.displayName).toBe(atCap);
  });

  test('refuses a step display name or step name over the cap', async () => {
    const { version, base } = await draft();
    await expect(tool.execute({ ...base, patches: [{ op: 'replace', path: '/nextAction/displayName', value: overCap }] }))
      .rejects.toThrow(`step displayName ${refused}`);
    await expect(tool.execute({ ...base, patches: [{ op: 'replace', path: '/nextAction/name', value: overCap }] }))
      .rejects.toThrow(`step name ${refused}`);
    expect(getFlowVersion(version.id)!.trigger).toEqual(graph() as any);
  });

  test('an over-long display name the draft already had cannot be copied to another step or field', async () => {
    const { base } = await draft(overCap);
    const added = { name: 'again', displayName: overCap, type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: '' } } };
    await expect(tool.execute({ ...base, patches: [{ op: 'add', path: '/nextAction/nextAction', value: added }] }))
      .rejects.toThrow(`step displayName ${refused}`);
    await expect(tool.execute({ ...base, patches: [{ op: 'add', path: '/displayName', value: overCap }] }))
      .rejects.toThrow(`step displayName ${refused}`);
  });

  test('is refused for its length before a credential check can quote it back', async () => {
    const { base } = await draft();
    const added = { name: overCap, type: 'PIECE', settings: { pieceName: 'jarvis-ask', actionName: 'ask', input: { prompt: '[redacted]' } } };
    const error = await tool.execute({ ...base, patches: [{ op: 'add', path: '/nextAction/nextAction', value: added }] })
      .then(() => null, (err: Error) => err.message);
    expect(error).toContain(`step name ${refused}`);
    expect(error).not.toContain(overCap);
  });

  test('an over-long step name the draft already had does not block another edit', async () => {
    const { version, base } = await draft(overCap);
    expect(unwrap(await tool.execute({ ...base, patches: [], name: 'Renamed' })).changed).toBe(true);
    expect(getFlowVersion(version.id)!.trigger.nextAction!.displayName).toBe(overCap);
  });
});
