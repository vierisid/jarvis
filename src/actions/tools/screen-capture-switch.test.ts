/**
 * #1314 m6: turning screen awareness off also turns off the tools that capture
 * the screen, on every path that runs or offers a tool, and closes workflow
 * cards waiting on a switch that was just turned off.
 */
import { afterEach, expect, test } from 'bun:test';
import { ToolRegistry } from './registry.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import { BUILTIN_TOOLS } from './builtin.ts';
import { DESKTOP_TOOLS } from './desktop.ts';
import { UI_TOOLS } from './ui.ts';
import { assertDesktopAllowed, bindScreenCaptureSwitch, setDesktopEnabledSource, setScreenCaptureEnabledSource, withoutDisabledDesktopTools,
  SCREEN_CAPTURE_DISABLED_CODE, SCREEN_CAPTURE_DISABLED_MESSAGE, desktopRefusal, screenAwarenessOffSystemNote, withoutScreenText } from './desktop-guard.ts';
import { switchedOffCard, workflowToolSwitchRefusal } from '../../workflows/runtime/workflow-ui-tools.ts';
import { fetchPebbleScreenshot } from '../../daemon/pebble-desktop-context.ts';

afterEach(() => { setScreenCaptureEnabledSource(null); setDesktopEnabledSource(null); });
const all = [...BUILTIN_TOOLS, ...[...DESKTOP_TOOLS, ...UI_TOOLS].filter(t => !BUILTIN_TOOLS.some(b => b.name === t.name))];
const byName = (name: string) => all.find(t => t.name === name)!;

test('awareness off refuses and hides the screenshot tools, and keeps actions that read nothing', async () => {
  const config = { awareness: { enabled: false } };
  bindScreenCaptureSwitch(config);
  const registry = new ToolRegistry();
  for (const name of ['desktop_screenshot', 'capture_screen', 'desktop_list_windows']) registry.register(byName(name));
  for (const name of ['desktop_screenshot', 'capture_screen']) {
    const error = await registry.execute(name, {}).catch(e => e);
    expect(error).toBeInstanceOf(ActionOutcomeError);
    expect((error as ActionOutcomeError).outcome).toMatchObject({ code: SCREEN_CAPTURE_DISABLED_CODE, effect: 'not_started' });
  }
  const offered = withoutDisabledDesktopTools(all).map(t => t.name);
  expect(offered).not.toContain('desktop_screenshot'); expect(offered).not.toContain('capture_screen');
  // Owner decision on #1314: screen text reads are off too; actions that read nothing stay.
  expect(offered).not.toContain('desktop_list_windows');
  expect(offered).toContain('desktop_launch_app');
  // Read live: turning it back on offers them again.
  config.awareness.enabled = true;
  expect(withoutDisabledDesktopTools(all).map(t => t.name)).toContain('capture_screen');
});

test('the pebble takes no screenshot while awareness is off', async () => {
  setScreenCaptureEnabledSource(() => false);
  let dispatched = 0;
  expect(await fetchPebbleScreenshot(async () => { dispatched++; return {}; }, 'pc')).toBeNull();
  expect(dispatched).toBe(0);
});

test('a workflow cannot be composed or enabled around a tool its switch has turned off', () => {
  setDesktopEnabledSource(() => false);
  expect(workflowToolSwitchRefusal(byName('desktop_launch_app'))).toMatchObject({ code: 'DESKTOP_DISABLED', message: expect.stringContaining('desktop control is turned off') });
  setDesktopEnabledSource(null); setScreenCaptureEnabledSource(() => false);
  expect(workflowToolSwitchRefusal(byName('desktop_screenshot'))).toMatchObject({ code: 'SCREEN_CAPTURE_DISABLED' });
  expect(workflowToolSwitchRefusal(byName('browser_screenshot'))).toMatchObject({ code: 'SCREEN_CAPTURE_DISABLED' });
  expect(workflowToolSwitchRefusal(byName('desktop_launch_app'))).toBeNull();
});


/** Every tool that hands back what is on a screen as text (owner decision on #1314). */
const TEXT_READS = ['desktop_snapshot', 'desktop_list_windows', 'desktop_find_element', 'ui_snapshot', 'ui_act'];

test('awareness off refuses and hides the on-screen text reads too, with the switch\'s own code', async () => {
  setScreenCaptureEnabledSource(() => false);
  const registry = new ToolRegistry();
  for (const name of [...TEXT_READS, 'desktop_click', 'desktop_launch_app']) registry.register(byName(name));
  for (const [name, params] of [...TEXT_READS.map(n => [n, {}] as const), ['desktop_click', { element_id: 3, action: 'get_value' }] as const]) {
    const error = await registry.execute(name, params as Record<string, unknown>).catch(e => e);
    expect(`${name}: ${(error as ActionOutcomeError)?.outcome?.code}`).toBe(`${name}: ${SCREEN_CAPTURE_DISABLED_CODE}`);
    expect((error as ActionOutcomeError).outcome.message).toContain('Screen awareness is turned off');
  }
  const offered = withoutDisabledDesktopTools(all).map(t => t.name);
  for (const name of TEXT_READS) expect(offered).not.toContain(name);
  // A click that writes reads nothing back from the screen: still offered, and still reviewed as before.
  expect(offered).toContain('desktop_click');
  for (const name of TEXT_READS) expect(workflowToolSwitchRefusal(byName(name))).toMatchObject({ code: 'SCREEN_CAPTURE_DISABLED' });
  expect(switchedOffCard(registry)({ tool_name: 'desktop_click', tool_arguments: JSON.stringify({ element_id: 3, action: 'get_value' }) })).toBe(true);
  expect(switchedOffCard(registry)({ tool_name: 'desktop_click', tool_arguments: JSON.stringify({ element_id: 3, action: 'set_value', value: 'x' }) })).toBe(false);
  expect(switchedOffCard(registry)({ tool_name: 'desktop_snapshot', tool_arguments: '{}' })).toBe(true);
});


test('reads by another name are off too: skill replays, recordings and a get_value in any case (#1314 review)', () => {
  setScreenCaptureEnabledSource(() => false);
  for (const [name, params] of [['run_skill', { name: 'x' }],
    ['record_skill', { action: 'start' }], ['desktop_click', { element_id: 1, action: 'GET_VALUE' }]] as const) {
    expect(desktopRefusal(byName(name), params)).toBe(SCREEN_CAPTURE_DISABLED_MESSAGE);
  }
  // Acting still works: a click and stopping a recording read nothing new.
  expect(desktopRefusal(byName('desktop_click'), { element_id: 1, action: 'click' })).toBeNull();
  expect(desktopRefusal(byName('record_skill'), { action: 'stop' })).toBeNull();
  const offered = withoutDisabledDesktopTools(all).map(t => t.name);
  expect(offered).not.toContain('run_skill');
});

test('the surface reader, app replies and the prompt follow the switch (#1314 review)', async () => {
  setScreenCaptureEnabledSource(() => false);
  const { captureSurface } = await import('../../structural/surface.ts');
  await expect(captureSurface({ kind: 'desktop' } as never)).rejects.toMatchObject({ outcome: { code: SCREEN_CAPTURE_DISABLED_CODE, effect: 'not_started' } });
  expect(withoutScreenText({ success: true, pid: 7, window_title: 'Inbox - ana@x - Outlook', note: 'window "Inbox" opened' }))
    .toEqual({ success: true, pid: 7, window_title: '(hidden: screen awareness is off)', note: '(hidden: screen awareness is off)' });
  expect(screenAwarenessOffSystemNote()).toContain('desktop_snapshot');
  expect(screenAwarenessOffSystemNote()).toContain('browser_navigate, browser_snapshot, browser_evaluate still work');
  setScreenCaptureEnabledSource(null);
  expect(screenAwarenessOffSystemNote()).toBeNull();
  expect(withoutScreenText({ window_title: 'Inbox' })).toEqual({ window_title: 'Inbox' });
});


test('pages Jarvis opens itself stay readable with awareness off; the desktop reads and screenshots still refuse (owner decision on #1314)', async () => {
  setScreenCaptureEnabledSource(() => false);
  const pageReads = [['browser_navigate', { url: 'https://a.example/' }], ['browser_snapshot', {}], ['browser_evaluate', { expression: 'document.title' }]] as const;
  const registry = new ToolRegistry();
  for (const [name] of pageReads) registry.register(byName(name));
  for (const [name, params] of pageReads) {
    expect(`${name}: ${desktopRefusal(byName(name), params)}`).toBe(`${name}: null`);
    expect(workflowToolSwitchRefusal(byName(name))).toBeNull();
    expect(switchedOffCard(registry)({ tool_name: name, tool_arguments: JSON.stringify(params) })).toBe(false);
    // The gate every dispatch path runs (registry.execute among them) lets it through. Not executed here: it would open a browser.
    expect(() => assertDesktopAllowed(byName(name), params as Record<string, unknown>)).not.toThrow();
  }
  const offered = withoutDisabledDesktopTools(all).map(t => t.name);
  for (const [name] of pageReads) expect(offered).toContain(name);
  for (const name of ['desktop_snapshot', 'desktop_list_windows', 'desktop_find_element', 'desktop_screenshot', 'capture_screen', 'browser_screenshot']) {
    expect(desktopRefusal(byName(name), {})).toBe(SCREEN_CAPTURE_DISABLED_MESSAGE);
    expect(offered).not.toContain(name);
  }
});
