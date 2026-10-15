import { describe, expect, test } from 'bun:test';
import { EmergencyController, type EmergencyState } from './emergency.ts';

describe('EmergencyController.subscribe (#987)', () => {
  test('every listener and the persistence callback hear each change, even past a listener that throws', () => {
    const emergency = new EmergencyController();
    const heard: string[] = [];
    emergency.subscribe(() => { throw new Error('broken listener'); });
    emergency.subscribe((s) => heard.push(`a:${s}`));
    emergency.setStateChangeCallback((s: EmergencyState) => heard.push(`persist:${s}`));
    emergency.pause();
    emergency.kill();
    emergency.reset();
    expect(heard).toEqual(['a:paused', 'persist:paused', 'a:killed', 'persist:killed', 'a:normal', 'persist:normal']);
    expect(emergency.getState()).toBe('normal');
  });

  test('an unsubscribed listener hears nothing more', () => {
    const emergency = new EmergencyController();
    const heard: string[] = [];
    const off = emergency.subscribe((s) => heard.push(s));
    emergency.kill();
    off();
    emergency.reset();
    expect(heard).toEqual(['killed']);
  });
});
