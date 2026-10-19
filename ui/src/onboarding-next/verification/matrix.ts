/** Fixture states the preview can render for each onboarding view, plus the replayable journeys. */
export const ROOMS = ['today', 'workflows', 'opportunities', 'needs-you', 'goals', 'memory', 'connected-workspace', 'authority', 'profile', 'settings', 'billing', 'pebble'] as const;
export const VIEWS = [
  { id: 'ON-U-01', name: 'welcome', export: 'WelcomeView', capability: 'welcome-view.v1', requires: ['journey.v1', 'setup.v1'], states: ['ready', 'pending', 'error', 'self', 'unknown', 'long'] },
  { id: 'ON-U-02', name: 'explainer', export: 'ExplainerView', capability: 'explainer-view.v1', requires: ['journey.v1', 'setup.v1'], states: ['ready', 'pending', 'error', 'long'] },
  { id: 'ON-U-03', name: 'google', export: 'GoogleView', capability: 'google-view.v1', requires: ['google-state.v1'], states: ['idle', 'pending', 'connected', 'cancelled', 'expired', 'error', 'unavailable', 'navigation-pending', 'long'] },
  { id: 'ON-U-04', name: 'interview', export: 'InterviewView', capability: 'interview-view.v1', requires: ['interview-session.v1', 'interview-profile.v1'], states: ['connecting', 'ready', 'thinking', 'error', 'done', 'skipped', 'resumed', 'streaming', 'saving-error', 'unknown-facts', 'navigation-pending', 'long'] },
  { id: 'ON-U-05', name: 'tour', export: 'TourView', capability: 'tour-view.v1', requires: ['tour.v1'], states: [...ROOMS, 'moving', 'error', 'unavailable'] },
  { id: 'ON-U-06', name: 'pebble-tour', export: 'PebbleTourView', capability: 'pebble-tour-view.v1', requires: ['tour.v1'], states: ['closed', 'open', 'moving', 'error', 'unavailable'] },
  { id: 'ON-U-07', name: 'activation', export: 'ActivationView', capability: 'activation-view.v1', requires: ['activation-intent.v1', 'build-job.v1'], states: ['ready', 'checking', 'submitting', 'needs_input', 'missing-connection', 'invalid', 'accepted', 'unavailable', 'unsupported', 'long'] },
  { id: 'ON-U-08', name: 'build', export: 'BuildView', capability: 'build-view.v1', requires: ['build-job.v1', 'draft-result.v1'], states: ['queued', 'understanding', 'building', 'validating', 'saving', 'needs_input', 'failed', 'cancelled', 'cancelling', 'disconnected', 'timed-out', 'saved', 'unavailable', 'long'] },
  { id: 'ON-U-09', name: 'result', export: 'ResultView', capability: 'result-view.v1', requires: ['draft-result.v1'], states: ['ready', 'review', 'needs_input', 'pending', 'deleted', 'missing-canvas', 'long'] },
] as const;
export const JOURNEYS = ['welcome-to-result', 'skip-connection-interview', 'failed-build-retry', 'tour-replay'] as const;
export type ViewName = typeof VIEWS[number]['name'];
export interface Case { id: string; owner: string; view: ViewName; state: string; theme: 'light' | 'dark'; sidebar: 'expanded' | 'rail'; }
/** Every view state in both themes; the tour, Pebble tour and result also in the rail sidebar. */
export function fixtureCases(): Case[] {
  const cases: Case[] = [];
  for (const view of VIEWS) for (const theme of ['light', 'dark'] as const) for (const state of view.states)
    for (const sidebar of view.name === 'tour' || view.name === 'pebble-tour' || view.name === 'result' ? ['expanded', 'rail'] as const : ['expanded'] as const)
      cases.push({ id: [view.name, state, theme, sidebar].join('--'), owner: view.id, view: view.name, state, theme, sidebar });
  return cases;
}
