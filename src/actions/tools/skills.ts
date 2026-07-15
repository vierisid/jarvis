/**
 * Skill tools — run_skill (execute a stored procedure) + manage_skills (list).
 *
 * run_skill takes the model out of the per-click loop: it names a skill and
 * its params, and the runtime executes + verifies each step over the
 * structural path with self-heal. The compact skill index is injected into the
 * prompt (see agent-service) so the model knows what is available.
 */

import type { ToolDefinition } from './registry.ts';
import { getSidecarManager, autoTargetForCapability } from './sidecar-route.ts';
import { captureSurface } from '../../structural/surface.ts';
import { runSkill, type SkillRuntimeDeps } from '../../skills/runtime.ts';
import { getSkillByName, listSkills, recordSkillRun, upsertSkill } from '../../vault/skills.ts';
import { skillIndexLine } from '../../skills/types.ts';
import { getRecorder } from '../../skills/recorder.ts';
import { compileSkill } from '../../skills/compiler.ts';

const RPC_TIMEOUT = { initial: 30_000, max: 60_000 };

function liveDeps(target: string): SkillRuntimeDeps {
  const manager = getSidecarManager();
  if (!manager) throw new Error('Sidecar system not initialized');
  const sidecar = manager.listSidecars().find((s) => s.id === target || s.name === target);
  const id = sidecar?.id ?? target;

  return {
    snapshot: async (kind) => {
      const { surface } = await captureSurface({ kind, target, full: false });
      return { nodes: surface.nodes, title: surface.root.title };
    },
    act: async (kind, sessionId, action, value) => {
      if (kind === 'browser') {
        if (action === 'set_value') {
          await manager.dispatchRPC(id, 'browser_ax_set_value', { backend_node_id: sessionId, value }, RPC_TIMEOUT);
        } else {
          await manager.dispatchRPC(id, 'browser_ax_click', { backend_node_id: sessionId }, RPC_TIMEOUT);
        }
        return;
      }
      await manager.dispatchRPC(id, 'click_element', { element_id: sessionId, action, value }, RPC_TIMEOUT);
    },
    raw: async (action, value) => {
      if (action === 'launch_app') {
        await manager.dispatchRPC(id, 'launch_app', { executable: value }, RPC_TIMEOUT);
      } else if (action === 'navigate') {
        await manager.dispatchRPC(id, 'browser_navigate', { url: value }, RPC_TIMEOUT);
      } else if (action === 'press_keys') {
        await manager.dispatchRPC(id, 'press_keys', { keys: value }, RPC_TIMEOUT);
      }
    },
  };
}

export const runSkillTool: ToolDefinition = {
  name: 'run_skill',
  description:
    'Execute a stored skill (a verified, parameterized procedure) by name. The runtime performs and verifies each step for you — you do not click through it yourself. Use manage_skills action="list" to see available skills and their parameters. Prefer a skill over manual ui_act steps when one matches the task.',
  category: 'ui',
  parameters: {
    name: { type: 'string', description: 'The skill name (from the skill index / manage_skills list).', required: true },
    params: { type: 'object', description: 'Parameter values for the skill, e.g. { "to": "a@b.com", "body": "hi" }.', required: false },
    target: { type: 'string', description: 'Sidecar name/ID (omit to auto-select).', required: false },
  },
  execute: async (params) => {
    const name = params.name as string;
    const skill = getSkillByName(name);
    if (!skill) {
      const avail = listSkills(true).map((s) => s.name).join(', ') || 'none';
      return `Error: no skill named "${name}". Available: ${avail}`;
    }
    const needsBrowser = skill.steps.some((s) => s.action === 'navigate');
    const cap = needsBrowser ? 'browser' : 'desktop';
    const target = (params.target as string | undefined)?.trim() || autoTargetForCapability(cap) || '';
    if (!target) return `Error: no connected sidecar with the "${cap}" capability`;

    const args = (params.params as Record<string, string> | undefined) ?? {};
    try {
      const result = await runSkill(skill, args, liveDeps(target));
      recordSkillRun(skill.id, result.ok);
      const lines = [`Skill "${skill.name}" ${result.ok ? 'completed' : `FAILED at step ${(result.failedAt ?? 0) + 1}`}:`];
      for (const s of result.steps) {
        lines.push(`  ${s.ok ? '✓' : '✗'} step ${s.index + 1} ${s.action}${s.healed ? ' (self-healed)' : ''} — ${s.detail}`);
      }
      if (!result.ok) lines.push('Do NOT assume the overall task succeeded — the skill stopped at the failed step above.');
      return lines.join('\n');
    } catch (err) {
      recordSkillRun(skill.id, false);
      return `Error running skill "${name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const manageSkillsTool: ToolDefinition = {
  name: 'manage_skills',
  description: 'List the available skills (verified, parameterized procedures you can run with run_skill).',
  category: 'ui',
  parameters: {
    action: { type: 'string', description: 'Only "list" is supported.', required: false, enum: ['list'] },
  },
  execute: async () => {
    const skills = listSkills(true);
    if (skills.length === 0) return 'No skills available yet. Skills are recorded by demonstration (record_skill) or authored.';
    return ['Available skills:', ...skills.map(skillIndexLine)].join('\n');
  },
};

export const recordSkillTool: ToolDefinition = {
  name: 'record_skill',
  description:
    'Learn a new skill by watching the user do a task once. action="start" begins recording the user\'s clicks and typing; the user then performs the task; action="stop" with a name compiles what was demonstrated into a reusable, parameterized skill. Typed values become parameters and secrets are redacted automatically.',
  category: 'ui',
  parameters: {
    action: { type: 'string', description: 'start or stop.', required: true, enum: ['start', 'stop'] },
    name: { type: 'string', description: 'On stop: the name to save the skill under (kebab-case, e.g. "gmail-compose").', required: false },
    description: { type: 'string', description: 'On stop: a one-line description of what the skill does.', required: false },
    target: { type: 'string', description: 'Sidecar name/ID (omit to auto-select).', required: false },
  },
  execute: async (params) => {
    const action = params.action as string;
    const recorder = getRecorder();
    const manager = getSidecarManager();
    const target = (params.target as string | undefined)?.trim() || autoTargetForCapability('desktop') || '';

    if (action === 'start') {
      if (recorder.isRecording()) return 'Already recording — call record_skill action="stop" first.';
      const id = `rec-${Math.random().toString(36).slice(2, 10)}`;
      recorder.start(id, Date.now());
      if (manager && target) {
        const sc = manager.listSidecars().find((s) => s.id === target || s.name === target);
        try { await manager.dispatchRPC(sc?.id ?? target, 'recorder_start', {}, RPC_TIMEOUT); } catch { /* input hook optional */ }
      }
      return 'Recording started. Tell the user to perform the task now, then call record_skill action="stop" with a name.';
    }

    if (action === 'stop') {
      const session = recorder.stop();
      if (manager && target) {
        const sc = manager.listSidecars().find((s) => s.id === target || s.name === target);
        try { await manager.dispatchRPC(sc?.id ?? target, 'recorder_stop', {}, RPC_TIMEOUT); } catch { /* ignore */ }
      }
      if (!session || session.interactions.length === 0) {
        return 'Nothing was recorded (no interactions captured). The recorder input hook may not be available on this platform yet.';
      }
      const name = (params.name as string | undefined)?.trim();
      if (!name) return `Recorded ${session.interactions.length} interactions but no name given. Call again with a name to save.`;
      const compiled = compileSkill(session.interactions, {
        name,
        description: params.description as string | undefined,
      });
      const saved = upsertSkill(compiled);
      return `Saved skill "${saved.name}" with ${saved.steps.length} steps and ${saved.params.length} parameters (${saved.params.map((p) => p.name).join(', ') || 'none'}). Run it with run_skill.`;
    }

    return 'Error: action must be "start" or "stop".';
  },
};

/** Compact skill index for prompt injection (empty string when none). */
export function buildSkillIndex(): string {
  const skills = listSkills(true);
  if (skills.length === 0) return '';
  return ['# Available Skills (run with run_skill)', ...skills.map(skillIndexLine)].join('\n');
}

export const SKILL_TOOLS: ToolDefinition[] = [runSkillTool, manageSkillsTool, recordSkillTool];
