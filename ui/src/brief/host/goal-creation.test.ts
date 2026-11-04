import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { registerNavigationCompatibility } from '../../../../src/brief/registrations/navigation-compatibility';
import { NavigationCompatibility } from '../navigation/controller';
import type { NavigationTarget } from '../navigation/destinations';
import { takeGoalCreation } from '../../v2/rooms/goals/create-request';
import { openGoalCreation } from './goal-creation';
GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => { takeGoalCreation(); });
// Leave Goals after each test so no test's leave listener outlives it.
afterEach(() => { window.location.hash = '#/'; window.dispatchEvent(new HashChangeEvent('hashchange')); });

const caps = () => new BriefCapabilities(registerNavigationCompatibility(() => ({ destinations: true, guardedNavigation: true, roomIntents: true, notificationsOutsideChat: true })), ['navigationCompatibility']).snapshot();
function navigation(opts: { leave?: boolean; commit?: (target: NavigationTarget) => void } = {}) {
  const opened: NavigationTarget[] = [], messages: string[] = [];
  const nav = new NavigationCompatibility({ roomAvailable: () => true, canLeave: async () => opts.leave ?? true,
    commit: target => { (opts.commit ?? (() => {}))(target); opened.push(target); }, explain: m => messages.push(m) });
  nav.setAccess(caps());
  return { nav, opened, messages };
}

test('a committed Add goal navigation asks Goals to open its create dialog once', async () => {
  const f = navigation();
  expect(await openGoalCreation(f.nav, m => f.messages.push(m))).toEqual({ state: 'opened' });
  expect(f.opened).toEqual([{ kind: 'legacy', hash: '#/_room_goals' }]);
  expect(takeGoalCreation()).toBe(true);
  expect(takeGoalCreation()).toBe(false);
});

test('a committed request that Goals never consumed is dropped when the hash leaves Goals', async () => {
  const f = navigation({ commit: () => { window.location.hash = '#/_room_goals'; } });
  expect(await openGoalCreation(f.nav, () => {})).toEqual({ state: 'opened' });
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  window.location.hash = '#/_room_memory';
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  expect(takeGoalCreation()).toBe(false);
});

test('a commit that throws leaves no create request for a later visit to Goals (#1245)', async () => {
  const f = navigation({ commit: () => { throw new Error('pushState refused'); } });
  expect(await openGoalCreation(f.nav, () => {})).toEqual({ state: 'unavailable' });
  expect(f.opened).toEqual([]);
  expect(f.messages).toContain('This destination could not be opened. Your current view is still available.');
  expect(takeGoalCreation()).toBe(false);
});

test('a cancelled leave guard leaves no create request', async () => {
  const f = navigation({ leave: false });
  expect(await openGoalCreation(f.nav, () => {})).toEqual({ state: 'cancelled' });
  expect(f.opened).toEqual([]);
  expect(takeGoalCreation()).toBe(false);
});
