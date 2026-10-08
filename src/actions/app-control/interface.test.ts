import { afterEach, test, expect, describe, spyOn } from 'bun:test';
import { __resetAppControllerForTests, getAppController, WSL_NO_LOCAL_DESKTOP } from './interface.ts';
import { ActionOutcomeError } from '../action-outcome.ts';
import { WSLBridge } from '../terminal/wsl-bridge.ts';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  __resetAppControllerForTests();
});

describe.skipIf(process.platform !== 'linux')('getAppController on Linux', () => {
  test('outside WSL it is the X11 controller, built once', () => {
    spies.push(spyOn(WSLBridge, 'isWSL').mockReturnValue(false));
    const ctrl = getAppController();
    expect(ctrl.constructor.name).toBe('LinuxAppController');
    expect(getAppController()).toBe(ctrl);
  });

  test('under WSL there is no local controller, and the refusal says nothing was done (#799)', () => {
    // It used to be the legacy desktop bridge's client, which needed a
    // desktop-bridge.exe nothing builds any more, and trusted whatever
    // answered its port. WSLg's X server cannot see the Windows desktop, so
    // LinuxAppController is not a stand-in (see WSL_NO_LOCAL_DESKTOP).
    spies.push(spyOn(WSLBridge, 'isWSL').mockReturnValue(true));
    let thrown: unknown;
    try {
      getAppController();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ActionOutcomeError);
    expect((thrown as ActionOutcomeError).outcome).toEqual({
      status: 'blocked', code: 'LOCAL_DESKTOP_UNAVAILABLE', effect: 'not_started', message: `Error: ${WSL_NO_LOCAL_DESKTOP}`,
    });
    expect(WSL_NO_LOCAL_DESKTOP).toContain('sidecar');
  });
});
