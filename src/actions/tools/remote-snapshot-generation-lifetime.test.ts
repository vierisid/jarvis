/**
 * #879 -- the per-reader record of remote snapshot generations
 * (`remoteSnapshotGenerations` in sidecar-route.ts) must not grow once per
 * sub-agent spawn for the life of the daemon.
 *
 * Two halves, because deleting alone is not enough: a sub-agent's keys are
 * dropped when its run settles, AND the record is capped, because an approved
 * call the agent raised can run after the agent has gone and records under the
 * reader that raised the card (`currentReviewedExecution().reader`), re-adding
 * a key no run will ever settle again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runSubAgent } from '../../agents/sub-agent-runner.ts';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { ToolRegistry } from './registry.ts';
import { browserSnapshotTool } from './builtin.ts';
import {
  forgetSnapshotReader, getSidecarManager, REMOTE_SNAPSHOT_GENERATIONS_CAP, remoteSnapshotGeneration, remoteSnapshotGenerationCount,
  resetRemoteSnapshotGenerations, setSidecarManagerRef,
} from './sidecar-route.ts';
import { runAsReviewed } from './reviewed-call-scope.ts';
import { withTemplateDeliveryScope } from './template-delivery-scope.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';
import type { SidecarInfo } from '../../sidecar/types.ts';
import type { LLMToolCall } from '../../llm/provider.ts';

const box: SidecarInfo = {
  id: 'remote-box',
  name: 'Remote Box',
  enrolled_at: '2026-01-01',
  last_seen_at: '2026-01-02',
  status: 'enrolled',
  connected: true,
  hostname: 'box',
  os: 'linux',
  platform: 'x64',
  capabilities: ['browser'],
  features: ['browser_elem_gen', 'browser_action_outcomes'],
  version: '0.11.0',
  latest_version: '0.11.0',
};

function fakeSidecar(): SidecarManager {
  let n = 0;
  return {
    getConnectionSessionId: () => 'fixture-session',
    listSidecars: () => [box],
    dispatchRPC: async () => ({
      text: 'Page: Bank\n[2] button "Send"',
      page_url: 'https://bank.example/',
      loader_id: 'L1',
      elem_gen: `epoch.${++n}`,
    }),
  } as unknown as SidecarManager;
}

function agent(id: string) {
  const history: Array<{ role: string; content: unknown }> = [];
  return {
    id, agent: { role: { id: 'fixture', name: 'Fixture', description: '', responsibilities: [] }, authority: { max_authority_level: 10 } },
    setTask() {}, activate() {}, idle() {},
    addMessage: (role: string, content: unknown) => history.push({ role, content }), getMessages: () => history,
  } as any;
}

/** A model that snapshots the remote browser once, then answers. */
function snapshottingModel() {
  let call = 0;
  const snap: LLMToolCall = { id: 's1', name: 'browser_snapshot', arguments: { target: 'remote-box' } };
  return { chatTier: async () => (call++ === 0
    ? { content: '', finish_reason: 'tool_use', tool_calls: [snap], usage: { input_tokens: 1, output_tokens: 1 } }
    : { content: 'done', finish_reason: 'end_turn', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) } as any;
}

const original = getSidecarManager();
beforeEach(() => {
  initDatabase(':memory:', { quiet: true });
  resetRemoteSnapshotGenerations();
  setSidecarManagerRef(fakeSidecar());
});
afterEach(() => {
  closeDb();
  resetRemoteSnapshotGenerations();
  setSidecarManagerRef(original as SidecarManager);
});

const asSubAgent = <T>(id: string, fn: () => T) => withTemplateDeliveryScope(`sub-agent:${id}`, fn);

describe('#879: remote snapshot generations do not outlive their reader', () => {
  test('a sub-agent\'s recorded generation is dropped when its run settles', async () => {
    const registry = new ToolRegistry();
    registry.register(browserSnapshotTool);
    // The chat's own record, which the sub-agent's settling must not touch.
    await browserSnapshotTool.execute({ target: 'remote-box' });
    const chatGen = remoteSnapshotGeneration('remote-box');
    expect(chatGen).not.toBeNull();

    const result = await runSubAgent({
      agent: agent('child-1'), task: 'look', context: '', llmManager: snapshottingModel(), toolRegistry: registry, maxIterations: 3,
    });
    expect(result.success).toBe(true);
    expect(result.toolsUsed).toContain('browser_snapshot');

    expect(asSubAgent('child-1', () => remoteSnapshotGeneration('remote-box'))).toBeNull();
    expect(remoteSnapshotGeneration('remote-box')).toBe(chatGen);
    expect(remoteSnapshotGenerationCount()).toBe(1);
  });

  test('a sub-agent that fails still drops its record', async () => {
    const registry = new ToolRegistry();
    registry.register(browserSnapshotTool);
    let call = 0;
    const model = { chatTier: async () => {
      if (call++ === 0) {
        return { content: '', finish_reason: 'tool_use', tool_calls: [{ id: 's1', name: 'browser_snapshot', arguments: { target: 'remote-box' } }],
          usage: { input_tokens: 1, output_tokens: 1 } };
      }
      // The snapshot did record, so the zero below is a deletion and not a
      // record that never happened.
      expect(remoteSnapshotGenerationCount()).toBe(1);
      throw new Error('model gone');
    } } as any;

    const result = await runSubAgent({ agent: agent('child-2'), task: 'look', context: '', llmManager: model, toolRegistry: registry, maxIterations: 3 });
    expect(result.success).toBe(false);
    expect(remoteSnapshotGenerationCount()).toBe(0);
  });

  test('forgetting one sub-agent leaves a sibling whose id it prefixes, on every sidecar', async () => {
    const other: SidecarInfo = { ...box, id: 'other-box', name: 'Other Box' };
    let n = 0;
    setSidecarManagerRef({
      getConnectionSessionId: () => 'fixture-session',
      listSidecars: () => [box, other],
      dispatchRPC: async () => ({ text: 'Page', page_url: 'https://bank.example/', loader_id: 'L1', elem_gen: `epoch.${++n}` }),
    } as unknown as SidecarManager);
    for (const id of ['a', 'ab']) {
      for (const target of ['remote-box', 'other-box']) {
        await asSubAgent(id, () => browserSnapshotTool.execute({ target }));
      }
    }
    expect(remoteSnapshotGenerationCount()).toBe(4);

    forgetSnapshotReader('sub-agent:a');

    expect(remoteSnapshotGenerationCount()).toBe(2);
    for (const target of ['remote-box', 'other-box']) {
      expect(asSubAgent('a', () => remoteSnapshotGeneration(target))).toBeNull();
      expect(asSubAgent('ab', () => remoteSnapshotGeneration(target))).not.toBeNull();
    }
  });

  test('approved calls from readers that are gone cannot grow the record past its cap', async () => {
    // Each of these is an approved remote navigate or snapshot run after the
    // sub-agent that raised its card settled: it records under that agent's
    // reader, and no run will settle that reader again.
    const readers = REMOTE_SNAPSHOT_GENERATIONS_CAP + 50;
    for (let i = 0; i < readers; i++) {
      await runAsReviewed({ reader: `named:sub-agent:gone-${i}` }, () => browserSnapshotTool.execute({ target: 'remote-box' }));
    }
    expect(remoteSnapshotGenerationCount()).toBe(REMOTE_SNAPSHOT_GENERATIONS_CAP);
    // The oldest went first; the newest is kept.
    expect(runAsReviewed({ reader: 'named:sub-agent:gone-0' }, () => remoteSnapshotGeneration('remote-box'))).toBeNull();
    expect(runAsReviewed({ reader: `named:sub-agent:gone-${readers - 1}` }, () => remoteSnapshotGeneration('remote-box')))
      .toBe(`epoch.${readers}`);
  });

  test('a reader that keeps snapshotting is not the one evicted', async () => {
    await browserSnapshotTool.execute({ target: 'remote-box' });
    for (let i = 0; i < REMOTE_SNAPSHOT_GENERATIONS_CAP + 10; i++) {
      await runAsReviewed({ reader: `named:sub-agent:gone-${i}` }, () => browserSnapshotTool.execute({ target: 'remote-box' }));
      // The chat snapshots again every so often; each write refreshes its place.
      if (i % 100 === 99) await browserSnapshotTool.execute({ target: 'remote-box' });
    }
    expect(remoteSnapshotGeneration('remote-box')).not.toBeNull();
  });
});
