import { describe, expect, test } from 'bun:test';
import { EmergencyController } from './emergency.ts';
import { createEmergencyPersister } from './emergency-persistence.ts';

function setup(failures: number) {
  const controller = new EmergencyController();
  const saved: string[] = [];
  const timers: Array<() => void> = [];
  let left = failures;
  const persist = createEmergencyPersister({
    controller,
    save: (state) => { if (left > 0) { left--; throw new Error('database or disk is full'); } saved.push(state); },
    describe: () => 'the disk is full',
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  controller.setStateChangeCallback(() => { persist(); });
  return { controller, saved, timers };
}

describe('emergency state persistence', () => {
  test('a failed save keeps the pause in effect, says it is unsaved, and retries', () => {
    const { controller, saved, timers } = setup(2);
    controller.pause();
    expect(controller.getState()).toBe('paused');
    expect(controller.persistence()).toEqual({ saved: false, reason: 'the disk is full' });
    expect(timers).toHaveLength(1);
    timers.shift()!();
    expect(controller.persistence().saved).toBe(false);
    timers.shift()!();
    expect(controller.persistence()).toEqual({ saved: true, reason: null });
    expect(saved).toEqual(['paused']);
  });

  test('a retry saves the current state, not the one that failed', () => {
    const { controller, saved, timers } = setup(2);
    controller.pause();
    controller.kill();
    timers.at(-1)!();
    expect(saved).toEqual(['killed']);
  });

  test('a save that works leaves the state saved', () => {
    const { controller, saved } = setup(0);
    controller.pause();
    expect(controller.persistence().saved).toBe(true);
    expect(saved).toEqual(['paused']);
  });
});
