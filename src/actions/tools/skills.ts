/**
 * Skill tools: run_skill (execute a stored procedure), manage_skills (list,
 * delete) and record_skill (learn by watching).
 *
 * run_skill takes the model out of the per-click loop: it names a skill and
 * its params, and the runtime executes and verifies each step over the
 * structural path. The compact skill index is injected into the prompt (see
 * agent-service) so the model knows what is available.
 *
 * AUTHORITY. The static TOOL_ACTION_MAP entry (control_app, the same as
 * desktop_click) is the floor. Each tool also carries an `authorityGate`,
 * which the orchestrator consults per call:
 *   - run_skill classifies the stored steps and gates the run on the worst
 *     case (src/skills/effects.ts), with an approval card that names what
 *     will actually happen ("click Send (sends email)") and the resolved
 *     parameter values. A category above the agent's level becomes an
 *     approval, not a silent denial: the same substitution request_approval
 *     makes for a declared intent.
 *   - record_skill start always needs the user's confirmation on a card.
 *     Installing system-wide input hooks is never something a model call
 *     does on its own; the model asks, the person clicks.
 *   - manage_skills delete is delete_data.
 *
 * INTEGRITY. A skill runs only when its stored MAC verifies. record_skill
 * never overwrites an existing name: a reviewed skill can only be replaced
 * by deleting it (gated) and recording again.
 */

import type { ToolDefinition, ToolGate } from './registry.ts';
import { getSidecarManager, autoTargetForCapability } from './sidecar-route.ts';
import { captureSurface } from '../../structural/surface.ts';
import { runSkill, type SkillRuntimeDeps } from '../../skills/runtime.ts';
import {
  deleteSkill, getSkillByName, listRunnableSkills, listSkills, matchSkills, recordSkillRun, upsertSkill,
} from '../../vault/skills.ts';
import { skillIndexLine, type Skill, type SurfaceKind } from '../../skills/types.ts';
import { resolveSkillEffect } from '../../skills/effects.ts';
import { getRecorder, type RecordingEndReason } from '../../skills/recorder.ts';
import { compileSkill } from '../../skills/compiler.ts';

const RPC_TIMEOUT = { initial: 30_000, max: 60_000 };
/** Hard cap on a recording session; the sidecar enforces the same cap on its hooks. */
export const RECORDING_MAX_MS = 10 * 60_000;
/** Actions the browser provider can carry out; anything else must fail loudly. */
const BROWSER_ACTIONS = new Set(['click', 'set_value']);

function sidecarIdFor(target: string): string {
  const manager = getSidecarManager();
  const sidecar = manager?.listSidecars().find((s) => s.id === target || s.name === target);
  return sidecar?.id ?? target;
}

/**
 * Live deps over the sidecar. The target is resolved per surface kind, so a
 * skill with browser and desktop steps reaches each through the sidecar that
 * advertises that capability; an explicit target pins both.
 */
function liveDeps(explicitTarget?: string): SkillRuntimeDeps {
  const manager = getSidecarManager();
  if (!manager) throw new Error('Sidecar system not initialized');
  const targetFor = (kind: SurfaceKind): string => {
    const t = explicitTarget || autoTargetForCapability(kind);
    if (!t) throw new Error(`no connected sidecar with the "${kind}" capability`);
    return t;
  };

  return {
    snapshot: async (kind) => {
      const { surface } = await captureSurface({ kind, target: targetFor(kind), full: false });
      return { nodes: surface.nodes, title: surface.root.title };
    },
    act: async (kind, sessionId, action, value) => {
      const id = sidecarIdFor(targetFor(kind));
      if (kind === 'browser') {
        if (!BROWSER_ACTIONS.has(action)) {
          throw new Error(`action "${action}" is not available on the browser surface (supported: click, set_value)`);
        }
        if (action === 'set_value') {
          await manager.dispatchRPC(id, 'browser_ax_set_value', { backend_node_id: sessionId, value }, RPC_TIMEOUT);
        } else {
          await manager.dispatchRPC(id, 'browser_ax_click', { backend_node_id: sessionId }, RPC_TIMEOUT);
        }
        return;
      }
      await manager.dispatchRPC(id, 'click_element', { element_id: sessionId, action, value }, RPC_TIMEOUT);
    },
    raw: async (kind, action, value) => {
      // navigate is inherently a browser action and launch_app inherently a
      // desktop one, whatever the step says. press_keys exists on both, so it
      // follows the step's surface: sending it to the desktop provider for a
      // browser step would inject an OS-level keystroke into whatever window
      // happens to be in the foreground, which for a step like the Slack
      // seed's Enter is the send.
      if (action === 'navigate') {
        await manager.dispatchRPC(sidecarIdFor(targetFor('browser')), 'browser_navigate', { url: value }, RPC_TIMEOUT);
        return;
      }
      if (action === 'press_keys') {
        if (kind === 'browser') {
          await manager.dispatchRPC(sidecarIdFor(targetFor('browser')), 'browser_press_key', { key: value }, RPC_TIMEOUT);
        } else {
          await manager.dispatchRPC(sidecarIdFor(targetFor('desktop')), 'press_keys', { keys: value }, RPC_TIMEOUT);
        }
        return;
      }
      if (action === 'launch_app') {
        await manager.dispatchRPC(sidecarIdFor(targetFor('desktop')), 'launch_app', { executable: value }, RPC_TIMEOUT);
        return;
      }
      throw new Error(`unsupported raw action "${action}"`);
    },
  };
}

/** Model-supplied params become string args; anything structured is refused. */
function argsFrom(raw: unknown): Record<string, string> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'params must be an object of parameter values';
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else return `parameter "${k}" must be a string`;
  }
  return out;
}

function integrityNote(s: Skill): string {
  if (s.integrity === 'ok') return '';
  return s.integrity === 'unsigned'
    ? ' [not runnable: stored before signing; delete and record again]'
    : ' [not runnable: content changed outside Jarvis; delete and record again]';
}

export const runSkillTool: ToolDefinition = {
  name: 'run_skill',
  description:
    'Execute a stored skill (a verified, parameterized procedure) by name. The runtime performs and verifies each step for you; you do not click through it yourself. Each run is checked against your authority for the most consequential step it contains (for example a click on Send is treated as sending email), so it can require the user\'s approval or be denied. Use manage_skills action="list" to see available skills and their parameters. Prefer a skill over manual ui_act steps when one matches the task.',
  category: 'ui',
  parameters: {
    name: { type: 'string', description: 'The skill name (from the skill index / manage_skills list).', required: true },
    params: { type: 'object', description: 'Parameter values for the skill, e.g. { "to": "a@b.com", "body": "hi" }.', required: false },
    target: { type: 'string', description: 'Sidecar name/ID (omit to auto-select).', required: false },
  },
  authorityGate: (params): ToolGate | null => {
    const skill = typeof params.name === 'string' ? getSkillByName(params.name) : null;
    if (!skill) return null;
    const args = argsFrom(params.params);
    const effect = resolveSkillEffect(skill, typeof args === 'string' ? {} : args);
    return { actionCategory: effect.category, actionCategories: effect.categories, intent: effect.intent, confirm: 'above_level' };
  },
  execute: async (params) => {
    const name = params.name as string;
    const skill = getSkillByName(name);
    if (!skill) {
      const avail = listRunnableSkills().map((s) => s.name).join(', ') || 'none';
      return `Error: no skill named "${name}". Available: ${avail}`;
    }
    if (!skill.enabled) return `Error: skill "${skill.name}" is disabled.`;
    if (skill.integrity !== 'ok') {
      return `Error: skill "${skill.name}" cannot run${integrityNote(skill)}.`;
    }
    const args = argsFrom(params.params);
    if (typeof args === 'string') return `Error: ${args}`;
    const effect = resolveSkillEffect(skill, args);
    if (effect.invalid) return `Error: skill "${skill.name}" cannot run: ${effect.invalid}.`;

    let deps: SkillRuntimeDeps;
    try {
      deps = liveDeps((params.target as string | undefined)?.trim() || undefined);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const result = await runSkill(skill, args, deps);
      recordSkillRun(skill.id, result.ok);
      const lines = [`Skill "${skill.name}" ${result.ok ? 'completed' : `FAILED at step ${(result.failedAt ?? 0) + 1}`}:`];
      for (const s of result.steps) {
        const mark = s.ok ? '[ok]' : '[failed]';
        const healed = s.healed ? ' (verified after re-observing)' : '';
        lines.push(`  ${mark} step ${s.index + 1} ${s.action}${healed}: ${s.detail}`);
      }
      if (!result.ok) {
        lines.push('Do NOT assume the overall task succeeded: the skill stopped at the failed step above. Nothing was retried. Read what changed before deciding whether to act again, and never repeat a step that sends, buys or deletes without checking first.');
      }
      return lines.join('\n');
    } catch (err) {
      recordSkillRun(skill.id, false);
      return `Error running skill "${name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const manageSkillsTool: ToolDefinition = {
  name: 'manage_skills',
  description: 'List the stored skills (verified, parameterized procedures you can run with run_skill), or delete one by name. Deleting is a destructive action and asks the user.',
  category: 'ui',
  parameters: {
    action: { type: 'string', description: '"list" (default) or "delete".', required: false, enum: ['list', 'delete'] },
    name: { type: 'string', description: 'delete: the skill name to remove.', required: false },
  },
  authorityGate: (params): ToolGate | null => {
    if (params.action !== 'delete') return null;
    const skill = typeof params.name === 'string' ? getSkillByName(params.name) : null;
    const what = skill ? `"${skill.name}" (v${skill.version}, ${skill.provenance}, ${skill.steps.length} steps)` : `"${String(params.name ?? '')}"`;
    return { actionCategory: 'delete_data', intent: `Delete skill ${what}` };
  },
  execute: async (params) => {
    if (params.action === 'delete') {
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      if (!name) return 'Error: delete needs the skill name.';
      const skill = getSkillByName(name);
      if (!skill) return `Error: no skill named "${name}".`;
      deleteSkill(skill.id);
      return `Deleted skill "${skill.name}" (v${skill.version}, ${skill.provenance}).`;
    }
    const skills = listSkills(false);
    if (skills.length === 0) return 'No skills stored yet. Skills are recorded by demonstration (record_skill) or authored.';
    return [
      'Stored skills:',
      ...skills.map((s) => `${skillIndexLine(s)}${s.enabled ? '' : ' [disabled]'}${integrityNote(s)}`),
    ].join('\n');
  },
};

const RECORDING_INTENT =
  'Start recording a skill: Jarvis watches your clicks and typing in every app until you stop it or 10 minutes pass';

let capTimer: ReturnType<typeof setTimeout> | null = null;

function clearCap(): void {
  if (capTimer) clearTimeout(capTimer);
  capTimer = null;
}

async function stopSidecarRecording(sidecarId: string): Promise<void> {
  const manager = getSidecarManager();
  if (!manager) return;
  try { await manager.dispatchRPC(sidecarId, 'recorder_stop', {}, RPC_TIMEOUT); } catch { /* hooks die with the sidecar anyway */ }
}

/** Sidecar-side end of a recording (cap hit, sidecar stop): close the brain-side session too. */
export function onRecordingStopped(reason: string): void {
  const mapped: RecordingEndReason = reason === 'cap' ? 'cap' : reason === 'rpc' ? 'stop' : 'sidecar';
  getRecorder().end(mapped);
  clearCap();
}

export const recordSkillTool: ToolDefinition = {
  name: 'record_skill',
  description:
    'Learn a new skill by watching the user do a task once. action="start" asks the user to confirm on a card; recording begins only when they approve it, and it stops on its own after 10 minutes. The user then performs the task while you wait. action="stop" with a name compiles what was demonstrated into a reusable, parameterized skill. Typed values become parameters and secrets are redacted automatically. A name that already exists is never overwritten: pick a new name, or delete the old skill first with manage_skills.',
  category: 'ui',
  parameters: {
    action: { type: 'string', description: 'start or stop.', required: true, enum: ['start', 'stop'] },
    name: { type: 'string', description: 'On stop: the name to save the skill under (kebab-case, e.g. "gmail-compose").', required: false },
    description: { type: 'string', description: 'On stop: a one-line description of what the skill does.', required: false },
    target: { type: 'string', description: 'Sidecar name/ID (omit to auto-select).', required: false },
  },
  authorityGate: (params): ToolGate | null =>
    params.action === 'start' ? { actionCategory: 'control_app', intent: RECORDING_INTENT, confirm: 'always' } : null,
  execute: async (params) => {
    const action = params.action as string;
    const recorder = getRecorder();
    const manager = getSidecarManager();
    const target = (params.target as string | undefined)?.trim() || autoTargetForCapability('desktop') || '';

    if (action === 'start') {
      if (recorder.isRecording()) return 'Already recording. Call record_skill action="stop" first.';
      if (!manager || !target) return 'Error: no connected sidecar with the "desktop" capability; nothing is being recorded.';
      const sidecarId = sidecarIdFor(target);
      // Discard anything left pending from an earlier session.
      recorder.takePending();
      try {
        await manager.dispatchRPC(sidecarId, 'recorder_start', { max_ms: RECORDING_MAX_MS }, RPC_TIMEOUT);
      } catch (err) {
        return `Error: could not start recording on the sidecar (${err instanceof Error ? err.message : String(err)}); nothing is being recorded.`;
      }
      const id = `rec-${Math.random().toString(36).slice(2, 10)}`;
      recorder.start(id, Date.now(), RECORDING_MAX_MS);
      clearCap();
      capTimer = setTimeout(() => {
        recorder.end('cap');
        void stopSidecarRecording(sidecarId);
      }, RECORDING_MAX_MS);
      capTimer.unref?.();
      return `Recording started; it stops on its own after ${Math.round(RECORDING_MAX_MS / 60_000)} minutes. Tell the user to perform the task now and to say when they are done, then call record_skill action="stop" with a name.`;
    }

    if (action === 'stop') {
      const session = recorder.end('stop');
      clearCap();
      if (manager && target) await stopSidecarRecording(sidecarIdFor(target));
      if (!session) return 'Nothing is recording and nothing is pending.';
      const ended = session.endReason === 'cap' ? ' (the recording had already stopped at the time limit)' : '';
      if (session.interactions.length === 0) {
        recorder.takePending();
        return `Nothing was recorded (no interactions captured)${ended}. The recorder input hook may not be available on this platform yet.`;
      }
      const name = (params.name as string | undefined)?.trim();
      if (!name) {
        return `Recorded ${session.interactions.length} interactions${ended} but no name was given. Call record_skill action="stop" again with a name to save.`;
      }
      const existing = getSkillByName(name);
      if (existing) {
        return `A skill named "${existing.name}" already exists (v${existing.version}, ${existing.provenance}); the recording was NOT saved over it and is still pending. Call stop again with a different name, or delete the existing skill first with manage_skills action="delete".`;
      }
      const compiled = compileSkill(session.interactions, {
        name,
        description: params.description as string | undefined,
      });
      if (compiled.steps.length === 0) {
        recorder.takePending();
        return `Recorded ${session.interactions.length} interactions${ended} but none could be compiled into a step (no element refs). Nothing was saved.`;
      }
      const saved = upsertSkill({ ...compiled, provenance: 'recorded' });
      recorder.takePending();
      const steps = saved.steps.map((s, i) => `  ${i + 1}. ${s.note ?? s.action}${s.postcondition ? ` [verify: ${s.postcondition.kind}]` : ''}`);
      return [
        `Saved skill "${saved.name}" (v${saved.version}) with ${saved.steps.length} steps and ${saved.params.length} parameters (${saved.params.map((p) => p.name).join(', ') || 'none'})${ended}.`,
        ...steps,
        'Show these steps to the user so they can check them. Run it with run_skill.',
      ].join('\n');
    }

    return 'Error: action must be "start" or "stop".';
  },
};

/**
 * Compact skill index for prompt injection (empty string when none). Skills
 * matching the message come first; the rest follow so the model can still
 * discover them.
 */
export function buildSkillIndex(message = '', ctx: { url?: string; processName?: string } = {}): string {
  const runnable = listRunnableSkills();
  if (runnable.length === 0) return '';
  const matched = message ? matchSkills(message, ctx) : [];
  const matchedIds = new Set(matched.map((s) => s.id));
  const rest = runnable.filter((s) => !matchedIds.has(s.id));
  const lines = ['# Available Skills (run with run_skill; a run is checked against your authority and may need approval)'];
  if (matched.length > 0) {
    lines.push('Matching this request:', ...matched.map(skillIndexLine));
    if (rest.length > 0) lines.push('Other skills:');
  }
  lines.push(...rest.map(skillIndexLine));
  return lines.join('\n');
}

export const SKILL_TOOLS: ToolDefinition[] = [runSkillTool, manageSkillsTool, recordSkillTool];
