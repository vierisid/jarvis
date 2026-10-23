/**
 * #905: `desktop.enabled: false` turns desktop control off.
 *
 * Before #905 nothing read the key, so setting it changed nothing. These pin
 * both halves of the switch on the REAL tool definitions: what the model is
 * offered (toolsInScope, realtime), and what runs (ToolRegistry.execute, which
 * every dispatch path goes through). The default -- no setting, or `true` --
 * must leave every tool exactly as it was.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry, type ToolDefinition } from './registry.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import { BUILTIN_TOOLS } from './builtin.ts';
import { DESKTOP_TOOLS, __setLocalDesktopControllerFactoryForTests } from './desktop.ts';
import { endRecordingForDesktopOff, runSkillTool } from './skills.ts';
import { getRecorder } from '../../skills/recorder.ts';
import { resetUiSnapshots, uiActTool } from './ui.ts';
import { getSidecarManager, setSidecarManagerRef } from './sidecar-route.ts';
import { toolsInScope, PROJECT_SITE_CHAT_SCOPE } from './tool-scope.ts';
import { realtimeToolDecision } from './tool-relevance/filter.ts';
import {
  DESKTOP_DISABLED_CODE, DESKTOP_DISABLED_MESSAGE, bindDesktopSwitch, callUsesDesktop, desktopEnabledFromConfig, desktopEnabledFromSection,
  desktopOffSystemNote, desktopValueNeedsWarning, isDesktopEnabled, setDesktopEnabledSource,
} from './desktop-guard.ts';
import { closeDb, initDatabase } from '../../vault/schema.ts';
import { setSkillSigningKey, upsertSkill } from '../../vault/skills.ts';
import type { SidecarManager } from '../../sidecar/manager.ts';

let desktopOn = true;
const originalManager = getSidecarManager();
/** Every RPC the tools tried to send while a test ran. */
let rpcs: string[] = [];
/** Every time a tool reached for the local desktop controller. */
let localReached = 0;

beforeEach(() => {
  desktopOn = true;
  rpcs = [];
  localReached = 0;
  setDesktopEnabledSource(() => desktopOn);
  // A connected sidecar with every capability, so an un-refused call has
  // somewhere to go and is visible here.
  setSidecarManagerRef({
    listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser', 'screenshot'] }],
    dispatchRPC: async (_id: string, method: string) => { rpcs.push(method); throw new Error('stub sidecar'); },
  } as unknown as SidecarManager);
  __setLocalDesktopControllerFactoryForTests(() => { localReached++; throw new Error('stub controller'); });
});

afterEach(() => {
  setDesktopEnabledSource(null);
  setSidecarManagerRef(originalManager as unknown as SidecarManager);
  __setLocalDesktopControllerFactoryForTests(null);
});

function registryOf(tools: readonly ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

async function refusal(run: () => Promise<unknown>): Promise<ActionOutcomeError | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof ActionOutcomeError && err.outcome.code === DESKTOP_DISABLED_CODE ? err : null;
  }
}

/** Arguments that pass each desktop tool's parameter validation. */
const ARGS: Record<string, Record<string, unknown>> = {
  desktop_click: { element_id: 1 },
  desktop_type: { text: 'hi' },
  desktop_press_keys: { keys: 'ctrl,s' },
  desktop_launch_app: { executable: 'notepad' },
  desktop_focus_window: { pid: 1 },
  desktop_find_element: { name: 'OK' },
};

describe('the setting', () => {
  test('defaults to on when nothing wired it', () => {
    setDesktopEnabledSource(null);
    expect(isDesktopEnabled()).toBe(true);
  });

  test('a reader that throws reads as off, never as on', () => {
    setDesktopEnabledSource(() => { throw new Error('config unreadable'); });
    expect(isDesktopEnabled()).toBe(false);
  });

  test('the stored value fails closed: only a missing value or a clear "on" keeps it on', () => {
    // What YAML 1.2 gives for the spellings a user might write.
    for (const off of [false, 'off', 'no', 'false', 'FALSE', 0, 'disabled', '', {}]) {
      expect({ value: off, on: desktopEnabledFromConfig(off) }).toEqual({ value: off, on: false });
    }
    // null is an empty `enabled:` line: no choice, so the default.
    for (const on of [undefined, null, true, 'true', 'yes', 'on', ' On ', 1, '1']) {
      expect({ value: on, on: desktopEnabledFromConfig(on) }).toEqual({ value: on, on: true });
    }
    // A section in the wrong shape is someone turning it off the wrong way.
    for (const section of [false, 'off', 'no', 0, []]) {
      expect({ section, on: desktopEnabledFromSection(section) }).toEqual({ section, on: false });
      expect(desktopValueNeedsWarning(section)).toBe(true);
    }
    expect(desktopEnabledFromSection(undefined)).toBe(true);
    // `desktop:` with nothing under it, e.g. after deleting #897's keys: the default.
    expect(desktopEnabledFromSection(null)).toBe(true);
    expect(desktopValueNeedsWarning(null)).toBe(false);
    expect(desktopEnabledFromSection({})).toBe(true);
    expect(desktopValueNeedsWarning({ enabled: false })).toBe(false);
    expect(desktopValueNeedsWarning(undefined)).toBe(false);
    expect(desktopValueNeedsWarning({ enabled: 'off' })).toBe(true);
    const config: { desktop?: unknown } = { desktop: { enabled: 'off' } };
    bindDesktopSwitch(config);
    expect(isDesktopEnabled()).toBe(false);
    config.desktop = false;
    expect(isDesktopEnabled()).toBe(false);
  });

  test('bindDesktopSwitch reads the config object live, so a reload applies without a restart', () => {
    const config: { desktop?: { enabled?: unknown } } = { desktop: { enabled: true } };
    bindDesktopSwitch(config);
    expect(isDesktopEnabled()).toBe(true);
    config.desktop!.enabled = false;
    expect(isDesktopEnabled()).toBe(false);
    config.desktop!.enabled = true;
    expect(isDesktopEnabled()).toBe(true);
    // An install with no desktop section at all keeps the default.
    delete config.desktop;
    expect(isDesktopEnabled()).toBe(true);
  });
});

test('the daemon binds the switch to its live config at boot', async () => {
  // startDaemon cannot be booted in a unit test; this pins the one line that
  // makes the setting do anything, so removing it fails here.
  const source = await Bun.file(new URL('../../daemon/index.ts', import.meta.url)).text();
  expect(source).toMatch(/^\s*bindDesktopSwitch\(jarvisConfig\);$/m);
});

describe('desktop.enabled: false refuses at ToolRegistry.execute', () => {
  const registry = () => registryOf(BUILTIN_TOOLS);

  test('every category-desktop builtin and capture_screen is refused, typed, and never reaches a sidecar or the local controller', async () => {
    const reachers = BUILTIN_TOOLS.filter((t) => t.category === 'desktop' || t.name === 'capture_screen');
    // The nine desktop_* tools plus capture_screen: a new desktop tool joins
    // this list on its own through its category.
    expect(reachers.map((t) => t.name).sort()).toEqual([...DESKTOP_TOOLS.map((t) => t.name), 'capture_screen'].sort());
    desktopOn = false;
    for (const tool of reachers) {
      const err = await refusal(() => registry().execute(tool.name, ARGS[tool.name] ?? {}));
      expect({ tool: tool.name, refused: err !== null }).toEqual({ tool: tool.name, refused: true });
      expect(err!.outcome).toEqual({ status: 'blocked', code: DESKTOP_DISABLED_CODE, effect: 'not_started', message: DESKTOP_DISABLED_MESSAGE });
    }
    expect(rpcs).toEqual([]);
    expect(localReached).toBe(0);
  });

  test('with the switch on (the default) the same calls are not refused and do reach the sidecar', async () => {
    for (const tool of DESKTOP_TOOLS) {
      expect(await refusal(() => registry().execute(tool.name, ARGS[tool.name] ?? {}))).toBeNull();
    }
    // Not vacuous: every un-refused call really went out to the sidecar.
    expect(rpcs.length).toBe(DESKTOP_TOOLS.length);
  });

  test('ui_snapshot is refused for the desktop (explicit or default kind) but not for the browser', async () => {
    desktopOn = false;
    expect(await refusal(() => registry().execute('ui_snapshot', { kind: 'desktop' }))).not.toBeNull();
    expect(await refusal(() => registry().execute('ui_snapshot', {}))).not.toBeNull();
    expect(rpcs).toEqual([]);
    expect(await refusal(() => registry().execute('ui_snapshot', { kind: 'browser' }))).toBeNull();
  });

  /** A sidecar whose get_window_tree shows one Send button; `onTree` runs on each capture. */
  const uiSidecar = (sent: string[], onTree: () => void = () => {}) => setSidecarManagerRef({
    listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'], unavailable_capabilities: [] }],
    dispatchRPC: async (_id: string, method: string) => {
      sent.push(method);
      if (method === 'get_window_tree') {
        onTree();
        return { window_title: 'Untitled - Notepad', pid: 42, elements: [{
          id: 1, name: 'Send', automation_id: '', class_name: 'Button', control_type: 'Button', enabled: true, focusable: true,
          rect: { x: 0, y: 30, w: 100, h: 24 }, patterns: ['Invoke'], depth: 1, path: [{ role: 'Window', name: 'Notepad' }], ordinal: 0, sig: 'sig-Send',
        }] };
      }
      return { success: true };
    },
  } as unknown as SidecarManager);
  const sendId = (snapshot: string) => Number(snapshot.split('\n').find((l) => l.includes('"Send"'))!.match(/^\[(\d+)\]/)![1]);

  test('ui_act is refused on an element a desktop snapshot captured, and never clicks', async () => {
    resetUiSnapshots();
    try {
      const sent: string[] = [];
      uiSidecar(sent);
      const id = sendId(String(await registry().execute('ui_snapshot', { kind: 'desktop' })));
      expect(callUsesDesktop(uiActTool, { element_id: id, action: 'click' })).toBe(true);
      // An id nothing captured is not a desktop element; execute refuses it itself.
      expect(callUsesDesktop(uiActTool, { element_id: id + 1000, action: 'click' })).toBe(false);
      desktopOn = false;
      sent.length = 0;
      expect(await refusal(() => registry().execute('ui_act', { element_id: id, action: 'click' }))).not.toBeNull();
      expect(sent).toEqual([]);
    } finally {
      resetUiSnapshots();
    }
  });

  test('ui_act turned off while it re-captures does not click', async () => {
    resetUiSnapshots();
    try {
      const sent: string[] = [];
      let captures = 0;
      // The second capture is ui_act's own re-read before acting: the switch
      // flips while it is in flight.
      uiSidecar(sent, () => { captures++; if (captures === 2) desktopOn = false; });
      const id = sendId(String(await registry().execute('ui_snapshot', { kind: 'desktop' })));
      const out = String(await registry().execute('ui_act', { element_id: id, action: 'click' }));
      expect(out).toContain(DESKTOP_DISABLED_MESSAGE);
      expect(sent.filter((m) => m === 'click_element')).toEqual([]);
    } finally {
      resetUiSnapshots();
    }
  });

  test('record_skill cannot start a recording, but can stop one', async () => {
    desktopOn = false;
    expect(await refusal(() => registry().execute('record_skill', { action: 'start' }))).not.toBeNull();
    expect(rpcs).toEqual([]);
    expect(await refusal(() => registry().execute('record_skill', { action: 'stop' }))).toBeNull();
  });

  test('turning the switch off ends a running recording, drops what it captured and takes the hooks off', async () => {
    rpcs = [];
    setSidecarManagerRef({
      listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop'] }],
      dispatchRPC: async (_id: string, method: string) => { rpcs.push(method); return { ok: true }; },
    } as unknown as SidecarManager);
    try {
      expect(String(await registry().execute('record_skill', { action: 'start' }))).toContain('Recording started');
      expect(getRecorder().isRecording()).toBe(true);
      desktopOn = false;
      expect(endRecordingForDesktopOff()).toBe(true);
      expect(getRecorder().isRecording()).toBe(false);
      expect(getRecorder().takePending()).toBeNull();
      await Bun.sleep(0);
      expect(rpcs).toEqual(['recorder_start', 'recorder_stop']);
      // Nothing running: a no-op.
      expect(endRecordingForDesktopOff()).toBe(false);
    } finally {
      // Never leave the process-wide recorder running for a later file.
      endRecordingForDesktopOff();
    }
  });

  test('run_skill is refused for a desktop or mixed skill and allowed for a browser-only one', async () => {
    initDatabase(':memory:');
    setSkillSigningKey(Buffer.alloc(32, 4));
    try {
      upsertSkill({ name: 'notepad', app: 'Notepad', steps: [
        { action: 'launch_app', value: 'notepad' },
        { action: 'set_value', surface: 'desktop', ref: { role: 'Document', name: 'Text editor', path: [], ordinal: 0, sig: '' }, value: 'x' },
      ] });
      upsertSkill({ name: 'mixed', app: 'Mixed', steps: [
        { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Go', path: [], ordinal: 0, sig: '' } },
        { action: 'click', surface: 'desktop', ref: { role: 'button', name: 'OK', path: [], ordinal: 0, sig: '' } },
      ] });
      upsertSkill({ name: 'web-only', app: 'Web', steps: [
        { action: 'click', surface: 'browser', ref: { role: 'button', name: 'Go', path: [], ordinal: 0, sig: '' } },
      ] });
      desktopOn = false;
      expect(callUsesDesktop(runSkillTool, { name: 'notepad' })).toBe(true);
      expect(callUsesDesktop(runSkillTool, { name: 'mixed' })).toBe(true);
      expect(callUsesDesktop(runSkillTool, { name: 'web-only' })).toBe(false);
      // A navigate's postcondition is read on the surface the step names.
      upsertSkill({ name: 'nav-desktop-check', app: 'X', steps: [{ action: 'navigate', surface: 'desktop', value: 'https://example.com', postcondition: { kind: 'window_appeared' } }] });
      upsertSkill({ name: 'nav-plain', app: 'X', steps: [{ action: 'navigate', value: 'https://example.com' }] });
      expect(callUsesDesktop(runSkillTool, { name: 'nav-desktop-check' })).toBe(true);
      expect(callUsesDesktop(runSkillTool, { name: 'nav-plain' })).toBe(false);
      // launch_app always goes to the desktop, whatever surface the step names.
      upsertSkill({ name: 'mislabelled', app: 'X', steps: [{ action: 'launch_app', surface: 'browser', value: 'notepad' }] });
      expect(callUsesDesktop(runSkillTool, { name: 'mislabelled' })).toBe(true);
      // An unknown name is the tool's own SKILL_NOT_FOUND, not a desktop refusal.
      expect(callUsesDesktop(runSkillTool, { name: 'nope' })).toBe(false);
      expect(await refusal(() => registry().execute('run_skill', { name: 'notepad' }))).not.toBeNull();
      expect(rpcs).toEqual([]);

      // Turned off between steps of a run that started while it was on: the
      // browser step went out, the desktop step after it did not.
      upsertSkill({ name: 'open-then-launch', app: 'Mixed', steps: [
        { action: 'navigate', value: 'https://example.com' },
        { action: 'launch_app', value: 'notepad' },
      ] });
      desktopOn = true;
      rpcs = [];
      setSidecarManagerRef({
        listSidecars: () => [{ id: 'pc-1', name: 'PC', connected: true, capabilities: ['desktop', 'browser'] }],
        dispatchRPC: async (_id: string, method: string) => {
          rpcs.push(method);
          if (method === 'browser_navigate') desktopOn = false;
          return { ok: true };
        },
      } as unknown as SidecarManager);
      const midRun = await registry().execute('run_skill', { name: 'open-then-launch' }).then(() => null, (e: unknown) => e);
      expect(midRun).toBeInstanceOf(ActionOutcomeError);
      // The step report names the switch as the reason, and earlier steps already ran.
      expect((midRun as ActionOutcomeError).outcome.effect).toBe('may_have_occurred');
      expect((midRun as ActionOutcomeError).outcome.message).toContain('step 2 launch_app: Error: Desktop control is turned off');
      expect(rpcs).toContain('browser_navigate');
      expect(rpcs.filter((m) => m !== 'browser_navigate')).toEqual([]);

      // A desktop postcondition read after the flip stops the run with the
      // switch's own code; it is not swallowed into an empty surface.
      upsertSkill({ name: 'open-then-launch-checked', app: 'Mixed', steps: [
        { action: 'navigate', value: 'https://example.com' },
        { action: 'launch_app', value: 'notepad', postcondition: { kind: 'window_appeared' } },
      ] });
      desktopOn = true;
      rpcs = [];
      const checked = await registry().execute('run_skill', { name: 'open-then-launch-checked' }).then(() => null, (e: unknown) => e);
      expect((checked as ActionOutcomeError).outcome).toMatchObject({ code: DESKTOP_DISABLED_CODE, effect: 'may_have_occurred' });
      expect((checked as ActionOutcomeError).outcome.message).toContain('stopped part way');
      expect((checked as ActionOutcomeError).outcome.message).not.toContain('so this was not run');
      expect(rpcs).toEqual(['browser_navigate']);
    } finally {
      closeDb();
      setSkillSigningKey(null);
    }
  });

  test('a declaration that throws is treated as reaching the desktop while the switch is off', () => {
    const tool: ToolDefinition = { name: 'x', description: 'x', category: 'ui', parameters: {}, execute: async () => null,
      usesDesktop: () => { throw new Error('cannot tell'); } };
    expect(callUsesDesktop(tool, {})).toBe(true);
  });
});

describe('desktop.enabled: false withholds the always-desktop tools from what is offered', () => {
  const ALWAYS = [...DESKTOP_TOOLS.map((t) => t.name), 'capture_screen'];

  test('toolsInScope drops them, with and without a scope, and keeps the mixed-surface tools', () => {
    desktopOn = false;
    for (const scope of [null, PROJECT_SITE_CHAT_SCOPE]) {
      const names = toolsInScope(BUILTIN_TOOLS, scope).map((t) => t.name);
      expect(names.filter((n) => ALWAYS.includes(n))).toEqual([]);
      for (const kept of ['ui_snapshot', 'ui_act', 'run_skill', 'record_skill', 'browser_navigate']) expect(names).toContain(kept);
    }
  });

  test('realtime sessions are offered the same narrowed list', () => {
    desktopOn = false;
    const names = realtimeToolDecision(BUILTIN_TOOLS).tools.map((t) => t.name);
    expect(names.filter((n) => ALWAYS.includes(n))).toEqual([]);
    expect(names).toContain('ui_snapshot');
  });

  test('with the switch on nothing changes: the very same list comes back', () => {
    expect(toolsInScope(BUILTIN_TOOLS, null)).toBe(BUILTIN_TOOLS);
    expect(realtimeToolDecision(BUILTIN_TOOLS).tools).toEqual([...BUILTIN_TOOLS]);
  });
});

describe('the prompt note', () => {
  test('is absent while on and says the tools are unavailable while off', () => {
    expect(desktopOffSystemNote()).toBeNull();
    desktopOn = false;
    const note = desktopOffSystemNote()!;
    expect(note).toContain('desktop.enabled: false');
    expect(note).toContain('desktop_*');
  });
});
