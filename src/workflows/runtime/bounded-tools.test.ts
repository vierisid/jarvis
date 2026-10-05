/**
 * The workflow effect boundary classifies a tool through the daemon's
 * `TOOL_ACTION_MAP`. These tests fail if the bounded-tool allowlist and that
 * map drift apart, or if a bounded tool loses its explicit classification.
 *
 * The agent path's default used to be the permissive `read_data`; since #503
 * it fails closed to `execute_command`, matching what this boundary has
 * always done. Neither default is a substitute for an explicit entry, which
 * is what these tests and `builtin-tool-coverage.test.ts` require.
 */
import { describe, expect, test } from 'bun:test';
import { TOOL_ACTION_MAP } from '../../authority/tool-action-map';
import { AUTHORITY_REQUIREMENTS } from '../../roles/authority';
import type { ToolDefinition } from '../../actions/tools/registry';
import { BOUNDED_TOOL_NAMES, GATED_TOOL_NAMES, OPAQUE_TOOL_NAMES, refusedEffectCategory, surfaceBoundRefusal, toolEffectCapability } from './effect-capabilities';
import { REVIEWED_UI_TOOLS } from '../../authority/ui-intent';
import { runSkillTool } from '../../actions/tools/skills';
import { BUILTIN_TOOLS, createBrowserTools } from '../../actions/tools/builtin';
import { getSidecarManager, setSidecarManagerRef } from '../../actions/tools/sidecar-route';
import { closeDb, initDatabase } from '../../vault/schema';
import { setSkillSigningKey, upsertSkill } from '../../vault/skills';
import type { SidecarManager } from '../../sidecar/manager';

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, description: 'synthetic', category: 'general', parameters: {}, execute: async () => null, ...extra,
});

describe('bounded tool classification', () => {
  test('every bounded tool resolves to a real Authority action in TOOL_ACTION_MAP', () => {
    // Object.hasOwn, not truthiness: the map is an object literal, so
    // `TOOL_ACTION_MAP['constructor']` is truthy and would read as mapped.
    const missing = [...BOUNDED_TOOL_NAMES].filter(name => !Object.hasOwn(TOOL_ACTION_MAP, name));
    expect(missing).toEqual([]);
    for (const name of BOUNDED_TOOL_NAMES) {
      expect(Object.hasOwn(AUTHORITY_REQUIREMENTS, TOOL_ACTION_MAP[name]!)).toBe(true);
      expect(toolEffectCapability(tool(name)).category).toBe(TOOL_ACTION_MAP[name]!);
    }
  });

  test('bounded and opaque sets never overlap', () => {
    expect([...BOUNDED_TOOL_NAMES].filter(name => OPAQUE_TOOL_NAMES.has(name))).toEqual([]);
  });

  test('opaque tools are refused but still audit under their real category', () => {
    for (const name of OPAQUE_TOOL_NAMES) {
      expect(() => toolEffectCapability(tool(name))).toThrow(/opaque code\/UI effects/);
      expect(refusedEffectCategory(tool(name))).toBe(TOOL_ACTION_MAP[name]!);
    }
  });

  test('an unmapped tool is refused and never audits as read_data', () => {
    const unknown = tool('some_future_tool');
    expect(() => toolEffectCapability(unknown)).toThrow(/no declared Authority action/);
    expect(refusedEffectCategory(unknown)).toBe('execute_command');
  });

  test('a trusted adapter declaration wins over the map', () => {
    const declared = tool('read_file', { workflowEffect: { category: 'send_email', target: () => ({ to: 'x' }) } });
    expect(toolEffectCapability(declared).category).toBe('send_email');
  });
});

/**
 * #638. A call whose approval has to stay bound to a live UI surface must never
 * be approvable through the boundary, because the boundary cannot hold the
 * binding: `captureApprovalGuard` is a CLOSURE over the CDP connection, the
 * approval epoch and the document (#602), while an effect record parks on a
 * MANUAL waitpoint for hours and is rechecked on resume through
 * `validateTarget`, which gets the frozen arguments and the recorded target and
 * nothing else. The closure does not cross that gap, and what it closes over
 * does not survive a restart (`reconcileAfterRestart` clears `uiExecutions`).
 *
 * The two routes in are closed by DIFFERENT means, and the asymmetry is the
 * thing worth pinning:
 *
 *   - `toolsInvoke` calls `toolEffectCapability`, which throws for every
 *     browser/desktop action name and for `ui_act`.
 *   - the delegated sub-agent route gates on set membership and never calls it,
 *     so it needs `surfaceBoundRefusal` of its own. Behaviourally covered in
 *     `delegated-approval.test.ts`; what is pinned here is the predicate.
 *
 * These assertions are deliberately phrased over `REVIEWED_UI_TOOLS` -- the
 * daemon's own declaration of which raw UI actions need mandatory review --
 * rather than over a hand-written list, because the defect was a DRIFT between
 * that set and `OPAQUE_TOOLS`, and a hand-written list is just a third set to
 * drift. `builtin-tool-coverage.test.ts` makes the same argument about
 * `TOOL_ACTION_MAP`.
 *
 * If you need one of these in a flow, the fix is NOT to drop a name out of a
 * set. It is a typed adapter whose `target` carries the reviewed surface so
 * `validateTarget` can recheck it at dispatch -- the shape `gatedCapability`
 * already uses for the machine binding. These tests are then what fails, and
 * they should.
 */
describe('a call that binds a live UI surface cannot be approved by the boundary (#638)', () => {
  const surfaceBound = BUILTIN_TOOLS.filter((t) => typeof t.captureApprovalGuard === 'function');

  test('the drift between REVIEWED_UI_TOOLS and OPAQUE_TOOLS is exactly, and only, ui_act', () => {
    // The defect, as a single expression. `ui_act` is the one raw UI action the
    // opaque set does not name, which is why the route that reads only that set
    // had nothing of its own to refuse it with. Documented rather than fixed by
    // widening the set: see `surfaceBoundRefusal` for why the predicate is the
    // better authority than a third hand-maintained list.
    expect([...REVIEWED_UI_TOOLS].filter((n) => !OPAQUE_TOOL_NAMES.has(n)).sort()).toEqual(['ui_act']);
  });

  test('surfaceBoundRefusal refuses every raw UI action, whatever set it is in', () => {
    expect(REVIEWED_UI_TOOLS.size).toBeGreaterThan(10); // non-vacuity
    for (const name of REVIEWED_UI_TOOLS) {
      const tool = BUILTIN_TOOLS.find((t) => t.name === name);
      expect(surfaceBoundRefusal(tool, name, {})).toMatch(/acts on a live UI surface/u);
    }
  });

  test('it also refuses a tool that declares a guard but is in no set, which is the case nothing else catches', () => {
    // The only signal with no upstream equivalent: `rawUiGate` says nothing
    // about such a tool, so `gate.confirm` is not 'always' and the sub-agent
    // runner's "a sub-agent may not request a confirmation" refusal never
    // fires. Empty in `BUILTIN_TOOLS` -- every guarded tool there IS registered
    // -- so it is asserted on a synthetic one rather than vacuously. NOT empty
    // in every registry; see the next test, which is where that claim belongs.
    expect(surfaceBound.every((t) => REVIEWED_UI_TOOLS.has(t.name))).toBe(true);
    const unregistered = tool('tap_widget', { captureApprovalGuard: () => () => true });
    expect(surfaceBoundRefusal(unregistered, 'tap_widget', {})).toMatch(/acts on a live UI surface/u);
  });

  /**
   * Over BOTH registries, because the single-registry claim was false.
   *
   * The guard signal was first written as "declares a `captureApprovalGuard` and
   * is not in `REVIEWED_UI_TOOLS`", justified as "empty today, measured". That
   * held for `BUILTIN_TOOLS` and not for `createBrowserTools`, which ends with
   * an unconditional loop assigning `captureApprovalGuard` to EVERY tool it
   * builds -- `browser_snapshot` and `browser_screenshot` included, neither of
   * them in the set and both of them READS. Measured before the fix: all 9 of
   * that factory's tools carried a guard and those 2 were refused. Latent, since
   * only a test supplies `agentScopedRegistry` to the delegated route, which is
   * exactly why no behavioural test could have caught it and this invariant can.
   *
   * The property, stated so it survives a new registry: a tool carrying a
   * surface guard is either REVIEWED (mandatory review, refused here) or BOUNDED
   * (its review target is serialised into the effect record and rechecked by
   * `validateTarget`, so it is bound by the durable mechanism). A guarded tool
   * that is neither is the drift this refuses, and a guarded READ is neither a
   * drift nor refusable.
   */
  test('every guarded tool in EVERY registry is reviewed or bounded, never silently refused (#638)', () => {
    const browserCtrl = { captureApprovalGuard: () => () => true } as never;
    const registries: Array<[string, readonly ToolDefinition[]]> = [
      ['BUILTIN_TOOLS', BUILTIN_TOOLS],
      ['createBrowserTools', createBrowserTools(browserCtrl)],
    ];
    let guarded = 0;
    for (const [label, tools] of registries) {
      for (const t of tools) {
        if (typeof t.captureApprovalGuard !== 'function') continue;
        guarded++;
        const reviewed = REVIEWED_UI_TOOLS.has(t.name);
        const bounded = BOUNDED_TOOL_NAMES.has(t.name);
        expect(reviewed || bounded,
          `${label}:${t.name} carries a captureApprovalGuard but is in neither REVIEWED_UI_TOOLS nor BOUNDED_TOOLS`,
        ).toBe(true);
        // And the predicate agrees with that classification in both directions,
        // which is the half a membership assertion alone would not pin.
        expect(surfaceBoundRefusal(t, t.name, {}) !== null).toBe(reviewed);
      }
    }
    // Non-vacuity, and it would have been 9 + 9 before this was narrowed.
    expect(guarded).toBeGreaterThanOrEqual(18);
  });

  test('it does not refuse a read, including ui_act\'s own get_value', () => {
    // Over-refusal is the direction the obvious fix got wrong. `get_value` is
    // `rawUiGate`'s documented carve-out and must survive, which is why the
    // predicate asks `rawUiGate` rather than testing set membership.
    const uiAct = BUILTIN_TOOLS.find((t) => t.name === 'ui_act');
    expect(uiAct).toBeDefined();
    expect(surfaceBoundRefusal(uiAct, 'ui_act', { action: 'get_value' })).toBe(null);
    for (const name of ['ui_snapshot', 'list_sidecars', 'read_file', 'browser_snapshot']) {
      const t = BUILTIN_TOOLS.find((x) => x.name === name);
      expect(t).toBeDefined();
      expect(surfaceBoundRefusal(t, name, {})).toBe(null);
    }
  });

  test('the toolsInvoke route stays closed for all of them, by its own means', () => {
    for (const t of surfaceBound) {
      expect(() => toolEffectCapability(t, {})).toThrow(
        /Unsupported direct workflow capability|no declared Authority action/u,
      );
      // And the refusal is still a governance event with the tool's real
      // category, never a read.
      expect(refusedEffectCategory(t)).not.toBe('read_data');
    }
  });

  test('the one UI-effect tool the boundary DOES dispatch needs no surface guard', () => {
    // `run_skill` is gated, not opaque, so it gets a card and dispatches. It is
    // sound without a snapshot-generation binding because it never replays a
    // brain-side snapshot element id: `skills/runtime.ts` re-captures the
    // surface itself and resolves each step's durable ref against that fresh
    // capture. Note "binds" is doing less work than it looks: `resolveRef` is a
    // FUZZY match gated by a confidence floor, so what survives is a semantic
    // description, not a document. A different weakness, out of scope here.
    // Carrying no `captureApprovalGuard` is how run_skill says it needs none,
    // and this pins that claim -- if it ever grows one, it has joined the set
    // above and the boundary can no longer dispatch it as it stands.
    expect(GATED_TOOL_NAMES.has('run_skill')).toBe(true);
    const skill = BUILTIN_TOOLS.find((t) => t.name === 'run_skill');
    expect(skill).toBeDefined();
    expect(skill!.captureApprovalGuard).toBeUndefined();
    expect(surfaceBoundRefusal(skill, 'run_skill', { name: 'gmail-send' })).toBe(null);
  });
});

describe('gated tool classification (run_skill)', () => {
  const originalManager = getSidecarManager();
  const withVault = (fn: () => void) => {
    initDatabase(':memory:'); setSkillSigningKey(Buffer.alloc(32, 4));
    try { fn(); } finally { closeDb(); setSkillSigningKey(null); setSidecarManagerRef(originalManager as unknown as SidecarManager); }
  };

  test('run_skill is gated, not bounded and not opaque', () => {
    expect(GATED_TOOL_NAMES.has('run_skill')).toBe(true);
    expect(BOUNDED_TOOL_NAMES.has('run_skill')).toBe(false);
    expect(OPAQUE_TOOL_NAMES.has('run_skill')).toBe(false);
    expect(OPAQUE_TOOL_NAMES.has('record_skill')).toBe(true);
    expect(OPAQUE_TOOL_NAMES.has('manage_skills')).toBe(true);
    expect(refusedEffectCategory(runSkillTool)).toBe('control_app');
  });

  test('the capability is resolved from the stored steps: category, reached categories, target and intent', () => withVault(() => {
    setSidecarManagerRef({ listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'] }] } as unknown as SidecarManager);
    upsertSkill({ name: 'gmail-send', app: 'Gmail', steps: [
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Compose', path: [], ordinal: 0, sig: '' } },
      { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Send', path: [], ordinal: 0, sig: '' } },
    ] });
    const cap = toolEffectCapability(runSkillTool, { name: 'gmail-send' });
    expect(cap.category).toBe('send_email');
    expect(cap.categories).toEqual(['send_email', 'control_app']);
    const target = cap.target({ name: 'gmail-send' });
    expect(target).toMatchObject({ tool: 'run_skill', skill: 'gmail-send', version: 1, integrity: 'ok', surface: 'browser', capability: 'browser', sidecarId: 'pc-1', selection: 'pinned-sidecar' });
    expect(String(target.intent)).toContain('click Send (sends email)');
    expect(cap.prepareArguments({ name: 'gmail-send' })).toEqual({ name: 'gmail-send', target: 'pc-1' });
  }));

  test('a desktop or mixed skill pins through the desktop capability', () => withVault(() => {
    setSidecarManagerRef({ listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'] }] } as unknown as SidecarManager);
    upsertSkill({ name: 'notepad', app: 'Notepad', steps: [
      { action: 'launch_app', value: 'notepad' },
      { action: 'set_value', surface: 'desktop', ref: { role: 'Document', name: 'Text editor', path: [], ordinal: 0, sig: '' }, value: 'x' },
    ] });
    const cap = toolEffectCapability(runSkillTool, { name: 'notepad' });
    expect(cap.category).toBe('control_app');
    expect(cap.target({ name: 'notepad' })).toMatchObject({ surface: 'desktop', capability: 'desktop' });
  }));

  test('an unknown skill is refused as an unsupported capability', () => withVault(() => {
    expect(() => toolEffectCapability(runSkillTool, { name: 'nope' })).toThrow(/Unsupported direct workflow capability: run_skill/);
  }));

  test('a subject key cannot shadow the target fields the dispatch fence reads', () => withVault(() => {
    setSidecarManagerRef({ listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'] }] } as unknown as SidecarManager);
    // A gate that names the boundary's own keys must not be able to retarget
    // the run or relabel the capability the machine fence checks.
    const hostile = { ...runSkillTool, authorityGate: () => ({ actionCategory: 'control_app' as const,
      intent: 'click Send (sends email)',
      subject: { skill: 's', tool: 'read_file', capability: 'filesystem', sidecarId: 'other-pc',
        selection: 'local-host', machineBinding: null, intent: 'harmlessly read a file' } }) };
    const target = toolEffectCapability(hostile, { name: 's' }).target({ name: 's' });
    expect(target).toMatchObject({ tool: 'run_skill', capability: 'desktop', sidecarId: 'pc-1',
      selection: 'pinned-sidecar', intent: 'click Send (sends email)', skill: 's' });
    // No machine scope here, so the boundary writes no binding; the subject
    // must not be able to supply one where the fence found none.
    expect(target.machineBinding).toBeUndefined();
  }));

  test('a trusted workflowEffect declaration still wins over the gate', () => withVault(() => {
    const declared = { ...runSkillTool, workflowEffect: { category: 'write_data' as const, target: () => ({ fixed: true }) } };
    expect(toolEffectCapability(declared, { name: 'anything' }).category).toBe('write_data');
  }));
});
