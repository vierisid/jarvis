import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { requestGoalCreation, takeGoalCreation, GOAL_CREATE_EVENT } from './create-request';
GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
test('goal creation intent works before mount and while mounted, and is consumed only once', () => {
  expect(takeGoalCreation()).toBe(false);
  requestGoalCreation(); expect(takeGoalCreation()).toBe(true); expect(takeGoalCreation()).toBe(false);
  let opened = 0;
  const listener = () => { if (takeGoalCreation()) opened++; };
  window.addEventListener(GOAL_CREATE_EVENT, listener);
  try { requestGoalCreation(); expect(opened).toBe(1); expect(takeGoalCreation()).toBe(false); }
  finally { window.removeEventListener(GOAL_CREATE_EVENT, listener); }
});
