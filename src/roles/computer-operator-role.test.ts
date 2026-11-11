import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadRole } from './loader.ts';
import { createScopedToolRegistry } from '../agents/sub-agent-runner.ts';

/**
 * #1314 m5: the computer-operator role reaches the browser and desktop tools it
 * is for, named one by one, and nothing else. A category entry such as
 * `general` handed it set_clipboard, capture_screen and get_system_info, and
 * set_clipboard ran with no card at its level.
 */
test('computer-operator is scoped to an explicit list of browser and desktop tools', () => {
  const role = loadRole(join(import.meta.dir, '..', '..', 'roles', 'specialists', 'computer-operator.yaml'));
  const names = createScopedToolRegistry(role.tools).list().map((tool) => tool.name).sort();
  expect(names).toEqual([
    'browser_click', 'browser_hover', 'browser_navigate', 'browser_press_key', 'browser_screenshot',
    'browser_scroll', 'browser_snapshot', 'browser_type',
    'desktop_click', 'desktop_find_element', 'desktop_focus_window', 'desktop_launch_app',
    'desktop_list_windows', 'desktop_screenshot', 'desktop_snapshot',
  ]);
  for (const name of ['set_clipboard', 'get_clipboard', 'capture_screen', 'get_system_info']) expect(names).not.toContain(name);
});

test('a tool named in a role is scoped by name, and a category still scopes its whole category', () => {
  expect(createScopedToolRegistry(['browser_navigate']).list().map((t) => t.name)).toEqual(['browser_navigate']);
  expect(createScopedToolRegistry(['general']).list().map((t) => t.name)).toContain('set_clipboard');
});

test('a role naming its tools keeps them under a parent that allows their categories, and only those (#1314)', async () => {
  const { AgentOrchestrator } = await import('../agents/orchestrator.ts');
  const orch = new AgentOrchestrator();
  const primary = orch.createPrimary({ id: 'pa', name: 'PA', description: 'A role.', responsibilities: ['x'], autonomous_actions: [],
    approval_required: [], tools: ['delegation', 'browser'], authority_level: 8 } as never);
  const child = orch.spawnSubAgent(primary.id, { id: 'op', name: 'OP', description: 'A role.', responsibilities: ['x'], autonomous_actions: [],
    approval_required: [], tools: ['browser_navigate', 'desktop_click'], authority_level: 3 } as never);
  // desktop_click's category is not the parent's, so the child does not get it.
  expect(child.agent.authority.allowed_tools).toEqual(['browser_navigate']);
});

test('a caller allowed a named tool by its category is not told the target has more tools (#1314 review)', async () => {
  const { AgentOrchestrator } = await import('../agents/orchestrator.ts');
  const { runAsActingAgent } = await import('../agents/acting-agent.ts');
  const orch = new AgentOrchestrator();
  const primary = orch.createPrimary({ id: 'pa', name: 'PA', description: 'A role.', responsibilities: ['x'], autonomous_actions: [],
    approval_required: [], tools: ['delegation', 'browser'], authority_level: 8 } as never);
  const caller = orch.spawnSubAgent(primary.id, { id: 'lead', name: 'LEAD', description: 'A role.', responsibilities: ['x'], autonomous_actions: [],
    approval_required: [], tools: ['delegation', 'browser'], authority_level: 6 } as never);
  const target = orch.spawnSubAgent(primary.id, { id: 'op', name: 'OP', description: 'A role.', responsibilities: ['x'], autonomous_actions: [],
    approval_required: [], tools: ['browser_navigate'], authority_level: 3 } as never);
  expect(runAsActingAgent({ agentId: caller.id, profile: null, taint: [] }, () => orch.delegationShortfall(target.id))).toBeNull();
});
