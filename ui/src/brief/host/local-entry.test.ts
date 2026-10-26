import { expect, test } from 'bun:test';
import { localIntegrationHref } from './local-entry';
test('fresh native dashboard and onboarding launch at the local Brief host', () => {
  for (const href of ['http://localhost:3143/', 'http://localhost:3143/?onboarding=1', 'http://localhost:3143/#/']) {
    const result = new URL(localIntegrationHref(href)); expect(result.hash).toBe('#/brief/today'); expect(result.searchParams.get('brief')).toBe('1'); expect(result.searchParams.has('onboarding')).toBe(false);
  }
});
test('native panels, maintenance and exact selections keep their own routes', () => {
  for (const suffix of ['?brief=0#/_room_settings', '?briefMaintenance=1#/_room_settings', '#/_panel_goals', '?brief=1#/brief/workflow-draft?flowId=f&versionId=v']) {
    const url = 'http://localhost:3143/' + suffix; expect(localIntegrationHref(url)).toBe(url);
  }
});
