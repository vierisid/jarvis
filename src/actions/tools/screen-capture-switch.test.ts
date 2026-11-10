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
import { bindScreenCaptureSwitch, setDesktopEnabledSource, setScreenCaptureEnabledSource, withoutDisabledDesktopTools,
  SCREEN_CAPTURE_DISABLED_CODE } from './desktop-guard.ts';
import { workflowToolDeclarationRefusal } from '../../workflows/runtime/workflow-ui-tools.ts';
import { fetchPebbleScreenshot } from '../../daemon/pebble-desktop-context.ts';

afterEach(() => { setScreenCaptureEnabledSource(null); setDesktopEnabledSource(null); });
const all = [...BUILTIN_TOOLS, ...DESKTOP_TOOLS.filter(t => !BUILTIN_TOOLS.some(b => b.name === t.name))];
const byName = (name: string) => all.find(t => t.name === name)!;

test('awareness off refuses and hides the screenshot tools, and only those', async () => {
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
  expect(offered).toContain('desktop_list_windows');
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
  expect(workflowToolDeclarationRefusal(byName('desktop_launch_app'))).toContain('desktop control is turned off');
  setDesktopEnabledSource(null); setScreenCaptureEnabledSource(() => false);
  expect(workflowToolDeclarationRefusal(byName('desktop_screenshot'))).toContain('screen awareness is turned off');
  expect(workflowToolDeclarationRefusal(byName('desktop_launch_app'))).toBeNull();
});
