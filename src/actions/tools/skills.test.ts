import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runSkillTool, manageSkillsTool, recordSkillTool, buildSkillIndex, onRecordingStopped, RECORDING_MAX_MS } from './skills.ts';
import { getSidecarManager, setSidecarManagerRef } from './sidecar-route.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';
import { closeDb, getDb, initDatabase } from '../../vault/schema.ts';
import { getSkillByName, setSkillSigningKey, upsertSkill } from '../../vault/skills.ts';
import { getRecorder } from '../../skills/recorder.ts';
import type { UiaSemanticElement } from '../../structural/types.ts';

const priorManager = getSidecarManager();
afterAll(() => {
  setSidecarManagerRef(priorManager as unknown as SidecarManager);
});

type Call = { method: string; params: Record<string, unknown> };

function el(id: number, control_type: string, name: string, extra: Partial<UiaSemanticElement> = {}): UiaSemanticElement {
  return {
    id, name, automation_id: '', class_name: control_type, control_type, enabled: true, focusable: true,
    rect: { x: 0, y: id * 30, w: 100, h: 24 }, patterns: control_type === 'Edit' ? ['Value'] : ['Invoke'], depth: 1,
    path: [{ role: 'Window', name: 'Notepad' }], ordinal: 0, sig: `sig-${name}`, ...extra,
  };
}

function fakeManager(calls: Call[], opts: { tree?: UiaSemanticElement[]; failRpc?: string } = {}): SidecarManager {
  return {
    listSidecars: () => [{ id: 'sc1', name: 'desktop-pc', connected: true, capabilities: ['desktop', 'browser'], unavailable_capabilities: [] }],
    dispatchRPC: async (_id: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (opts.failRpc === method) throw new Error(`${method}: not supported on this platform`);
      if (method === 'get_window_tree') return { window_title: 'Untitled - Notepad', pid: 42, elements: opts.tree ?? [] };
      if (method === 'browser_ax_snapshot') return { url: 'https://x.test', title: 'x', elements: [] };
      return { success: true };
    },
  } as unknown as SidecarManager;
}

describe('skill tools', () => {
  beforeEach(() => { initDatabase(':memory:'); setSkillSigningKey(Buffer.alloc(32, 3)); });
  afterEach(() => { closeDb(); setSkillSigningKey(null); getRecorder().end('restart'); getRecorder().takePending(); });

  describe('run_skill', () => {
    test('the gate resolves the worst case of the stored steps and a card-ready intent', () => {
      upsertSkill({
        name: 'mail', app: 'Gmail', steps: [
          { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Compose', path: [], ordinal: 0, sig: '' } },
          { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: '' } },
        ],
      });
      const gate = runSkillTool.authorityGate!({ name: 'mail', params: {} })!;
      expect(gate.actionCategory).toBe('send_email');
      expect(gate.confirm).toBe('above_level');
      expect(gate.intent).toContain('click Send (sends email)');
      // Unknown skill: no gate, the static floor applies and execute reports the miss.
      expect(runSkillTool.authorityGate!({ name: 'nope' })).toBeNull();
    });

    test('refuses a tampered skill before touching the sidecar', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls));
      const s = upsertSkill({ name: 'note', steps: [{ action: 'click', ref: { role: 'Button', name: 'OK', path: [], ordinal: 0, sig: '' } }] });
      getDb().prepare("UPDATE skills SET steps_json = '[]' WHERE id = ?").run(s.id);
      const out = String(await runSkillTool.execute({ name: 'note' }));
      expect(out).toContain('cannot run');
      expect(out).toContain('content changed outside Jarvis');
      expect(calls).toHaveLength(0);
    });

    test('runs a desktop skill through the sidecar and reports each step', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls, { tree: [el(1, 'Button', 'OK')] }));
      upsertSkill({ name: 'ok', steps: [{ action: 'click', ref: { role: 'Button', name: 'OK', path: [], ordinal: 0, sig: 'sig-OK' } }] });
      const out = String(await runSkillTool.execute({ name: 'ok', params: {} }));
      expect(out).toContain('completed');
      expect(out).toContain('[ok] step 1 click');
      expect(calls.map((c) => c.method)).toEqual(['get_window_tree', 'click_element']);
      expect(calls[1]!.params).toEqual({ element_id: 1, action: 'click', value: undefined });
      expect(getSkillByName('ok')!.runCount).toBe(1);
    });

    test('a failed step is reported as failed and never retried', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls, { tree: [el(1, 'Button', 'Send')] }));
      upsertSkill({ name: 'send', steps: [{ action: 'click', ref: { role: 'Button', name: 'Send', path: [], ordinal: 0, sig: 'sig-Send' }, postcondition: { kind: 'element_gone' } }] });
      const out = String(await runSkillTool.execute({ name: 'send' }));
      expect(out).toContain('FAILED at step 1');
      expect(out).toContain('NOT repeated');
      expect(calls.filter((c) => c.method === 'click_element')).toHaveLength(1);
      expect(getSkillByName('send')!.successCount).toBe(0);
    });

    test('a browser skill refuses actions the browser provider does not have', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls));
      upsertSkill({ name: 'nav', steps: [{ action: 'navigate', value: 'https://x.test' }] });
      const out = String(await runSkillTool.execute({ name: 'nav' }));
      expect(out).toContain('completed');
      expect(calls[0]).toEqual({ method: 'browser_navigate', params: { url: 'https://x.test' } });
    });
  });

  describe('manage_skills', () => {
    test('list shows every skill with its integrity; delete is gated as delete_data and removes it', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls));
      const s = upsertSkill({ name: 'a', description: 'does a', steps: [{ action: 'wait', ms: 1 }] });
      upsertSkill({ name: 'b', description: 'does b', steps: [{ action: 'wait', ms: 1 }] });
      getDb().prepare("UPDATE skills SET steps_json = '[{\"action\":\"wait\",\"ms\":2}]' WHERE id = ?").run(s.id);
      const listed = String(await manageSkillsTool.execute({ action: 'list' }));
      expect(listed).toContain('- a(): does a [not runnable: content changed outside Jarvis');
      expect(listed).toContain('- b(): does b');
      expect(manageSkillsTool.authorityGate!({ action: 'list' })).toBeNull();
      const gate = manageSkillsTool.authorityGate!({ action: 'delete', name: 'b' })!;
      expect(gate.actionCategory).toBe('delete_data');
      expect(gate.intent).toContain('Delete skill "b"');
      expect(String(await manageSkillsTool.execute({ action: 'delete', name: 'b' }))).toContain('Deleted skill "b"');
      expect(getSkillByName('b')).toBeNull();
      expect(String(await manageSkillsTool.execute({ action: 'delete', name: 'b' }))).toContain('no skill named');
    });
  });

  describe('record_skill', () => {
    test('start always needs the person to confirm; stop does not', () => {
      const start = recordSkillTool.authorityGate!({ action: 'start' })!;
      expect(start.confirm).toBe('always');
      expect(start.actionCategory).toBe('control_app');
      expect(start.intent).toContain('recording a skill');
      expect(recordSkillTool.authorityGate!({ action: 'stop', name: 'x' })).toBeNull();
    });

    test('start asks the sidecar for a capped recording and does not open a session when the hook fails', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls, { failRpc: 'recorder_start' }));
      const out = String(await recordSkillTool.execute({ action: 'start' }));
      expect(out).toContain('could not start recording');
      expect(out).toContain('nothing is being recorded');
      expect(getRecorder().isRecording()).toBe(false);
      expect(calls[0]).toEqual({ method: 'recorder_start', params: { max_ms: RECORDING_MAX_MS } });
    });

    test('start opens a bounded session; stop compiles, and never overwrites an existing name', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls));
      upsertSkill({ name: 'gmail-compose', description: 'reviewed', steps: [{ action: 'wait', ms: 1 }], provenance: 'authored' });

      expect(String(await recordSkillTool.execute({ action: 'start' }))).toContain('Recording started');
      const rec = getRecorder();
      expect(rec.isRecording()).toBe(true);
      expect(rec.current()!.deadline - rec.current()!.startedAt).toBe(RECORDING_MAX_MS);
      rec.push({ action: 'click', ref: { role: 'button', name: 'Compose', path: [], ordinal: 0, sig: 'c' }, ts: 1, surface: 'browser' });
      rec.push({ action: 'set_value', ref: { role: 'textbox', name: 'Subject', path: [], ordinal: 0, sig: 's' }, value: 'hello', ts: 2, surface: 'browser' });

      // Stop without a name: the session stays pending.
      const noName = String(await recordSkillTool.execute({ action: 'stop' }));
      expect(noName).toContain('Recorded 2 interactions');
      expect(calls.map((c) => c.method)).toEqual(['recorder_start', 'recorder_stop']);
      expect(rec.pending()).not.toBeNull();

      // Stop with a taken name: refused, still pending, the reviewed skill untouched.
      const taken = String(await recordSkillTool.execute({ action: 'stop', name: 'gmail-compose' }));
      expect(taken).toContain('already exists');
      expect(taken).toContain('NOT saved');
      expect(getSkillByName('gmail-compose')!.description).toBe('reviewed');
      expect(getSkillByName('gmail-compose')!.version).toBe(1);
      expect(rec.pending()).not.toBeNull();

      // Stop with a fresh name: saved as recorded, signed, pending consumed.
      const saved = String(await recordSkillTool.execute({ action: 'stop', name: 'my-compose', description: 'mine' }));
      expect(saved).toContain('Saved skill "my-compose" (v1)');
      expect(saved).not.toContain('hello');
      const skill = getSkillByName('my-compose')!;
      expect(skill.provenance).toBe('recorded');
      expect(skill.integrity).toBe('ok');
      expect(skill.steps.map((s) => s.action)).toEqual(['click', 'set_value']);
      expect(skill.steps[1]!.value).toBe('{{subject}}');
      expect(rec.pending()).toBeNull();
    });

    test('a sidecar-side end (cap) closes the brain session so stop reports it', async () => {
      const calls: Call[] = [];
      setSidecarManagerRef(fakeManager(calls));
      await recordSkillTool.execute({ action: 'start' });
      getRecorder().push({ action: 'click', ref: { role: 'Button', name: 'OK', path: [], ordinal: 0, sig: 'k' }, ts: 1 });
      onRecordingStopped('cap');
      expect(getRecorder().isRecording()).toBe(false);
      const out = String(await recordSkillTool.execute({ action: 'stop' }));
      expect(out).toContain('stopped at the time limit');
      expect(out).toContain('Recorded 1 interactions');
    });
  });

  describe('buildSkillIndex', () => {
    test('lists runnable skills with matches first and leaves tampered ones out', () => {
      upsertSkill({ name: 'gmail-compose', app: 'Gmail', description: 'send mail', steps: [{ action: 'wait', ms: 1 }], match: { keywords: ['email'] } });
      upsertSkill({ name: 'notion-new-page', app: 'Notion', description: 'new page', steps: [{ action: 'wait', ms: 1 }], match: { keywords: ['notion'] } });
      const bad = upsertSkill({ name: 'evil', description: 'x', steps: [{ action: 'wait', ms: 1 }] });
      getDb().prepare("UPDATE skills SET steps_json = '[]' WHERE id = ?").run(bad.id);

      const idx = buildSkillIndex('please send an email to bob');
      expect(idx.indexOf('gmail-compose')).toBeLessThan(idx.indexOf('notion-new-page'));
      expect(idx).toContain('Matching this request');
      expect(idx).not.toContain('evil');
      expect(buildSkillIndex()).not.toContain('Matching this request');
    });
  });
});
