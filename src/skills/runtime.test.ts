import { describe, expect, it } from 'bun:test';
import { runSkill, validateSteps, type SkillRuntimeDeps, type SkillSurface } from './runtime.ts';
import type { Skill, SkillStep } from './types.ts';
import { surfaceFromUia, type SemanticNode, type SemanticRef } from '../structural/types.ts';

function node(role: string, name: string, sig: string, sessionId: number, focused = false): SemanticNode {
  return {
    ref: { role, name, path: [], ordinal: 0, sig },
    role, name, value: null,
    state: { enabled: true, focused },
    bounds: null, actions: ['click', 'set_value'], sessionId,
  };
}
function ref(role: string, name: string, sig: string): SemanticRef {
  return { role, name, path: [], ordinal: 0, sig };
}

function skill(steps: SkillStep[], params: Skill['params'] = []): Skill {
  return {
    id: 's', name: 'test', app: '', description: '', match: {}, params, steps,
    provenance: 'authored', version: 1, enabled: true, integrity: 'ok', successCount: 0, runCount: 0,
    createdAt: 0, updatedAt: 0,
  };
}

type Act = [number, string, string?];

/** Deps whose snapshot returns a scripted sequence of surfaces (last one repeats). */
function scriptedDeps(surfaces: Array<SkillSurface | Error>): { deps: SkillRuntimeDeps; acts: Act[]; raws: Array<[string, string, string?]>; snapshots: () => number } {
  const acts: Act[] = [];
  const raws: Array<[string, string, string?]> = [];
  let i = 0;
  const deps: SkillRuntimeDeps = {
    snapshot: async () => {
      const s = surfaces[Math.min(i++, surfaces.length - 1)]!;
      if (s instanceof Error) throw s;
      return s;
    },
    act: async (_k, sid, action, value) => { acts.push([sid, action, value]); },
    raw: async (kind, action, value) => { raws.push([kind, action, value]); },
    sleep: async () => {},
  };
  return { deps, acts, raws, snapshots: () => i };
}

describe('runSkill', () => {
  it('fills params and runs an element step verified by postcondition', async () => {
    const target = node('Edit', 'Body', 'body-sig', 7);
    const after = node('Edit', 'Body', 'body-sig', 7);
    after.value = 'hello world';
    const s = skill(
      [{ action: 'set_value', ref: ref('Edit', 'Body', 'body-sig'), value: '{{text}}', postcondition: { kind: 'value_equals', value: '{{text}}' } }],
      [{ name: 'text', type: 'string', description: 't', required: true }],
    );
    const { deps, acts } = scriptedDeps([{ nodes: [target] }, { nodes: [after] }]);
    const res = await runSkill(s, { text: 'hello world' }, deps);
    expect(acts[0]).toEqual([7, 'set_value', 'hello world']);
    expect(res.steps[0]!.ok).toBe(true);
    expect(res.steps[0]!.healed).toBeUndefined();
  });

  it('fills a missing param from its default and lets a caller value override it', async () => {
    const field = node('Edit', 'Text editor', 'te', 4);
    const s = skill(
      [{ action: 'set_value', ref: ref('Edit', 'Text editor', 'te'), value: '{{text_editor}}' }],
      [{ name: 'text_editor', type: 'string', description: '', required: false, default: 'coffee 4 euros' }],
    );
    const a = scriptedDeps([{ nodes: [field] }]);
    expect((await runSkill(s, {}, a.deps)).ok).toBe(true);
    expect(a.acts[0]).toEqual([4, 'set_value', 'coffee 4 euros']);
    const b = scriptedDeps([{ nodes: [field] }]);
    expect((await runSkill(s, { text_editor: 'taxi 12' }, b.deps)).ok).toBe(true);
    expect(b.acts[0]).toEqual([4, 'set_value', 'taxi 12']);
  });

  it('a required secret param with no default is still refused when missing', async () => {
    const s = skill(
      [{ action: 'set_value', ref: ref('Edit', 'Password', 'pw'), value: '{{password}}' }],
      [{ name: 'password', type: 'string', description: '', required: true, secret: true }],
    );
    const { deps, acts } = scriptedDeps([{ nodes: [node('Edit', 'Password', 'pw', 1)] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.detail).toContain('missing required parameter "password"');
    expect(acts).toHaveLength(0);
  });

  it('rejects missing required params before doing anything', async () => {
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'x') }], [{ name: 'to', type: 'string', description: '', required: true }]);
    const { deps, acts } = scriptedDeps([{ nodes: [] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(-1);
    expect(acts).toHaveLength(0);
  });

  it('rejects an enum param outside its options before doing anything', async () => {
    const s = skill(
      [{ action: 'set_value', ref: ref('Edit', 'Priority', 'p'), value: '{{level}}' }],
      [{ name: 'level', type: 'enum', description: '', required: true, options: ['low', 'high'] }],
    );
    const { deps, acts } = scriptedDeps([{ nodes: [node('Edit', 'Priority', 'p', 1)] }]);
    const res = await runSkill(s, { level: 'urgent' }, deps);
    expect(res.ok).toBe(false);
    expect(res.steps[0]!.detail).toContain('must be one of: low, high');
    expect(acts).toHaveLength(0);
  });

  it('refuses a malformed skill (unknown action, missing ref) before dispatching', async () => {
    const bad = skill([{ action: 'hover' as unknown as SkillStep['action'], ref: ref('Button', 'x', 'x') }]);
    const { deps, acts, raws } = scriptedDeps([{ nodes: [node('Button', 'x', 'x', 1)] }]);
    const res = await runSkill(bad, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(-1);
    expect(res.steps[0]!.detail).toContain('unknown action "hover"');
    expect(acts).toHaveLength(0);
    expect(raws).toHaveLength(0);

    expect(validateSteps([{ action: 'click' }])).toContain('no target ref');
    expect(validateSteps([{ action: 'launch_app' }])).toContain('no value');
    expect(validateSteps([])).toContain('no steps');
  });

  it('fails the step when the ref cannot be resolved', async () => {
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'send-sig') }]);
    const { deps } = scriptedDeps([{ nodes: [node('Button', 'Discard', 'other', 1)] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(0);
    expect(res.steps[0]!.detail).toContain('could not locate');
  });

  it('fails the step, not the process, when there is no surface to capture', async () => {
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'send-sig') }]);
    const { deps, acts } = scriptedDeps([new Error('no foreground window found')]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(0);
    expect(res.steps[0]!.detail).toContain('could not capture the desktop surface');
    expect(res.steps[0]!.detail).toContain('no foreground window');
    expect(acts).toHaveLength(0);
  });

  it('a raw step whose target app is absent fails with the sidecar message', async () => {
    const s = skill([{ action: 'launch_app', value: 'nope.exe', postcondition: { kind: 'window_appeared' } }, { action: 'wait', ms: 1 }]);
    const { deps } = scriptedDeps([{ nodes: [] }]);
    deps.raw = async () => { throw new Error('launch_app: executable not found: nope.exe'); };
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(0);
    expect(res.steps[0]!.detail).toContain('executable not found');
    expect(res.steps).toHaveLength(1);
  });

  it('verifies after re-observing without dispatching the action again', async () => {
    const btn = node('Button', 'Send', 'send-sig', 3);
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'send-sig'), postcondition: { kind: 'element_gone' } }]);
    // snapshots: [pre-act], [verify#1 still present], [re_resolve re-read: gone]
    const { deps, acts } = scriptedDeps([
      { nodes: [btn] },
      { nodes: [btn] },
      { nodes: [] },
    ]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(true);
    expect(res.steps[0]!.healed).toBe(true);
    expect(acts).toHaveLength(1);
  });

  it('never re-dispatches: an unconfirmed Send is clicked exactly once and reported', async () => {
    const btn = node('Button', 'Send', 'send-sig', 3);
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'send-sig'), postcondition: { kind: 'element_gone' } }]);
    // The button never goes away.
    const { deps, acts, snapshots } = scriptedDeps([{ nodes: [btn] }]);
    const res = await runSkill(s, {}, deps);
    expect(acts).toHaveLength(1);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe(0);
    expect(res.steps[0]!.detail).toContain('NOT repeated');
    expect(res.steps[0]!.detail).toContain('still present');
    // pre-act + first check + re_resolve + settle = 4 reads, then report.
    expect(snapshots()).toBe(4);
  });

  it('fallback: skip lets an unverifiable step pass, still without a second dispatch', async () => {
    const field = node('Edit', 'Type to continue', 'tc', 9);
    const s = skill([{ action: 'set_value', ref: ref('Edit', 'Type to continue', 'tc'), value: 'x', postcondition: { kind: 'value_equals', value: 'x' }, fallback: 'skip' }]);
    const { deps, acts } = scriptedDeps([{ nodes: [field] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(true);
    expect(res.steps[0]!.detail).toContain('skipped per step fallback');
    expect(acts).toHaveLength(1);
  });

  it('title_changed compares against the title captured before the step, not any non-empty title', async () => {
    const btn = node('Button', 'Next', 'next', 2);
    const s = skill([{ action: 'click', ref: ref('Button', 'Next', 'next'), postcondition: { kind: 'title_changed' } }]);
    // Same title before and after: a no-op click must not pass.
    const same = scriptedDeps([{ nodes: [btn], title: 'Step 1' }]);
    const r1 = await runSkill(s, {}, same.deps);
    expect(r1.ok).toBe(false);
    expect(r1.steps[0]!.detail).toContain('title is still');

    const changed = scriptedDeps([{ nodes: [btn], title: 'Step 1' }, { nodes: [btn], title: 'Step 2' }]);
    const r2 = await runSkill(s, {}, changed.deps);
    expect(r2.ok).toBe(true);
  });

  it('window_appeared fails on an unchanged surface and passes on new content', async () => {
    const s = skill([{ action: 'launch_app', value: 'notepad.exe', postcondition: { kind: 'window_appeared' } }]);
    const same = scriptedDeps([{ nodes: [node('Document', 'Text Editor', 'te', 1)], title: 'Untitled - Notepad' }]);
    const r1 = await runSkill(s, {}, same.deps);
    expect(r1.ok).toBe(false);
    expect(r1.steps[0]!.detail).toContain('unchanged');

    const opened = scriptedDeps([
      { nodes: [node('Pane', 'Desktop', 'd', 1)], title: 'Desktop' },
      { nodes: [node('Document', 'Text Editor', 'te', 2)], title: 'Untitled - Notepad' },
    ]);
    const r2 = await runSkill(s, {}, opened.deps);
    expect(r2.ok).toBe(true);
    expect(r2.steps[0]!.detail).toContain('title changed');
  });

  it('surface_changed holds when the clicked element is gone or content appeared, fails when nothing moved', async () => {
    const send = node('Button', 'Send', 'send', 5);
    const s = skill([{ action: 'click', ref: ref('Button', 'Send', 'send'), postcondition: { kind: 'surface_changed' } }]);

    const gone = scriptedDeps([{ nodes: [send], title: 'Inbox' }, { nodes: [], title: 'Inbox' }]);
    expect((await runSkill(s, {}, gone.deps)).ok).toBe(true);

    const toast = scriptedDeps([{ nodes: [send], title: 'Inbox' }, { nodes: [send, node('Text', 'Message sent', 'ms', 6)], title: 'Inbox' }]);
    expect((await runSkill(s, {}, toast.deps)).ok).toBe(true);

    const nothing = scriptedDeps([{ nodes: [send], title: 'Inbox' }]);
    const r = await runSkill(s, {}, nothing.deps);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.detail).toContain('surface is unchanged');
    expect(nothing.acts).toHaveLength(1);
  });

  it('runs raw actions (launch_app) and wait steps', async () => {
    const s = skill([
      { action: 'launch_app', value: 'notepad.exe' },
      { action: 'wait', ms: 100 },
    ]);
    const { deps, raws } = scriptedDeps([{ nodes: [] }]);
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(true);
    expect(raws[0]).toEqual(['desktop', 'launch_app', 'notepad.exe']);
  });

  it('value_equals holds on a desktop surface, whose fields carry their text', async () => {
    // The Go semantic walk emits `value` for any element with a Value
    // pattern; semanticNodeFromUia must carry it onto the node or every
    // recorded set_value step fails its derived value_equals.
    const uia = {
      window_title: 'Untitled - Notepad', pid: 42,
      elements: [{
        id: 7, name: 'Subject', automation_id: 'subj', class_name: 'Edit',
        control_type: 'Edit', enabled: true, focusable: true,
        rect: { x: 0, y: 0, w: 10, h: 10 }, patterns: ['Value'], depth: 1,
        path: [{ role: 'Window', name: 'Untitled - Notepad' }], ordinal: 0,
        sig: 'subj-sig', value: 'hello',
      }],
    };
    const surface = surfaceFromUia(uia);
    expect(surface.nodes[0]!.value).toBe('hello');

    const s = skill([{
      action: 'set_value',
      surface: 'desktop',
      ref: { role: 'Edit', name: 'Subject', stableId: 'subj', path: [{ role: 'Window', name: 'Untitled - Notepad' }], ordinal: 0, sig: 'subj-sig' },
      value: '{{subject}}',
      postcondition: { kind: 'value_equals', value: '{{subject}}' },
    }], [{ name: 'subject', type: 'string', description: '', required: true }]);

    const deps: SkillRuntimeDeps = {
      snapshot: async () => ({ nodes: surface.nodes, title: surface.root.title }),
      act: async () => {},
      raw: async () => {},
      sleep: async () => {},
    };
    const res = await runSkill(s, { subject: 'hello' }, deps);
    expect(res.ok).toBe(true);
    expect(res.steps[0]!.detail).toContain('value equals');
  });

  it('a key press follows the step surface: browser steps do not reach the desktop provider', async () => {
    const desktop = scriptedDeps([{ nodes: [] }]);
    await runSkill(skill([{ action: 'press_keys', value: 'enter' }]), {}, desktop.deps);
    expect(desktop.raws[0]).toEqual(['desktop', 'press_keys', 'enter']);

    const browser = scriptedDeps([{ nodes: [] }]);
    await runSkill(skill([{ action: 'press_keys', surface: 'browser', value: 'enter' }]), {}, browser.deps);
    expect(browser.raws[0]).toEqual(['browser', 'press_keys', 'enter']);
  });

  it('a browser step snapshots and acts on the browser surface', async () => {
    const seen: string[] = [];
    const btn = node('button', 'Compose', 'c', 11);
    const s = skill([{ action: 'click', surface: 'browser', ref: ref('button', 'Compose', 'c') }]);
    const deps: SkillRuntimeDeps = {
      snapshot: async (kind) => { seen.push(`snap:${kind}`); return { nodes: [btn] }; },
      act: async (kind) => { seen.push(`act:${kind}`); },
      raw: async () => {},
      sleep: async () => {},
    };
    const res = await runSkill(s, {}, deps);
    expect(res.ok).toBe(true);
    expect(seen).toEqual(['snap:browser', 'act:browser']);
  });
});

describe('a run that is watched, stopped and gone on with', () => {
  const three = (): Skill => skill([
    { action: 'click', ref: ref('Button', 'One', 'one') },
    { action: 'press_keys', value: 'enter' },
    { action: 'click', ref: ref('Button', 'Two', 'two') },
  ]);
  const surface: SkillSurface = { nodes: [node('Button', 'One', 'one', 1), node('Button', 'Two', 'two', 2)] };

  it('tells the watcher of every step, before it is dispatched and when it has ended', async () => {
    const { deps, acts } = scriptedDeps([surface]);
    const seen: string[] = [];
    const result = await runSkill(three(), {}, deps, {
      onStep: (event) => {
        // The watcher hears of a step before anything of it was sent.
        if (event.phase === 'start' && event.index === 0) expect(acts.length).toBe(0);
        seen.push(`${event.phase} ${event.index + 1}/${event.total} ${event.step.action}${event.target ? ` on ${event.target.name}` : ''}${event.ok === undefined ? '' : event.ok ? ' ok' : ' failed'}`);
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      'start 1/3 click on One', 'end 1/3 click ok',
      'start 2/3 press_keys', 'end 2/3 press_keys ok',
      'start 3/3 click on Two', 'end 3/3 click ok',
    ]);
  });

  it('asked to stop, it dispatches nothing more and says where it stopped', async () => {
    const { deps, acts, raws } = scriptedDeps([surface]);
    const stop = new AbortController();
    const result = await runSkill(three(), {}, deps, { signal: stop.signal, onStep: (event) => { if (event.phase === 'end' && event.index === 0) stop.abort(); } });
    expect(result).toMatchObject({ ok: false, stoppedAt: 1 });
    expect(result.failedAt).toBeUndefined();
    expect(acts).toEqual([[1, 'click', undefined]]);
    expect(raws).toEqual([]);
  });

  it('a stop asked while the watcher has its moment still lands before the step', async () => {
    const { deps, acts } = scriptedDeps([surface]);
    const stop = new AbortController();
    const result = await runSkill(three(), {}, deps, { signal: stop.signal, onStep: (event) => { if (event.phase === 'start' && event.index === 0) stop.abort(); } });
    expect(result).toMatchObject({ ok: false, stoppedAt: 0 });
    expect(acts).toEqual([]);
  });

  it('going on starts at the step it stopped before, and nothing is done twice', async () => {
    const { deps, acts, raws } = scriptedDeps([surface]);
    const stop = new AbortController();
    const first = await runSkill(three(), {}, deps, { signal: stop.signal, onStep: (event) => { if (event.phase === 'end' && event.index === 0) stop.abort(); } });
    const second = await runSkill(three(), {}, deps, { from: first.stoppedAt });
    expect(second.ok).toBe(true);
    expect(second.steps.map((step) => step.index)).toEqual([1, 2]);
    expect(acts).toEqual([[1, 'click', undefined], [2, 'click', undefined]]);
    expect(raws).toEqual([['desktop', 'press_keys', 'enter']]);
  });

  it('after a failure it says where to go on from: the step itself if nothing of it was sent, the next one if it was', async () => {
    // The target of the last step is not on the screen: nothing of it was dispatched.
    const missing = scriptedDeps([{ nodes: [node('Button', 'One', 'one', 1)] }]);
    expect(await runSkill(three(), {}, missing.deps)).toMatchObject({ ok: false, failedAt: 2, resumeAt: 2 });
    // The key press threw from inside the dispatch: it may have happened.
    const thrown = scriptedDeps([surface]);
    thrown.deps.raw = async () => { throw new Error('the machine went away'); };
    expect(await runSkill(three(), {}, thrown.deps)).toMatchObject({ ok: false, failedAt: 1, resumeAt: 2 });
    // Dispatched once and not verified: it is never dispatched again.
    const unverified = scriptedDeps([surface]);
    const send = skill([{ action: 'click', ref: ref('Button', 'One', 'one'), postcondition: { kind: 'surface_changed' } }]);
    expect(await runSkill(send, {}, unverified.deps)).toMatchObject({ ok: false, failedAt: 0, resumeAt: 1 });
    expect(unverified.acts.length).toBe(1);
  });

  it('a watcher that throws does not stop the run, and a step that is not there cannot be gone on from', async () => {
    const { deps, acts } = scriptedDeps([surface]);
    expect((await runSkill(three(), {}, deps, { onStep: () => { throw new Error('the watcher broke'); } })).ok).toBe(true);
    expect(acts.length).toBe(2);
    const refused = await runSkill(three(), {}, deps, { from: 7 });
    expect(refused).toMatchObject({ ok: false, failedAt: -1 });
    expect(acts.length).toBe(2);
  });
});
