/** Local frozen v1 projections. Verification has no production registration. */
export const PROVIDERS = [
  ['ON-B-01', 'journey', 'journey.v1', []],
  ['ON-B-02', 'setup', 'setup.v1', []],
  ['ON-B-03', 'google', 'google-state.v1', []],
  ['ON-B-04', 'interview-session', 'interview-session.v1', ['interview-profile.v1']],
  ['ON-B-05', 'interview-profile', 'interview-profile.v1', []],
  ['ON-B-06', 'tour', 'tour.v1', ['journey.v1']],
  ['ON-B-07', 'activation-intent', 'activation-intent.v1', []],
  ['ON-B-08', 'build-jobs', 'build-job.v1', ['activation-intent.v1', 'compose-draft.v1']],
  ['ON-B-09', 'compose-draft', 'compose-draft.v1', []],
  ['ON-B-10', 'result', 'draft-result.v1', ['build-job.v1']],
  ['ON-B-12', 'diagnostics', 'diagnostics.v1', []],
] as const;
export const VIEWS = ['welcome', 'explainer', 'google', 'interview', 'tour', 'pebble-tour', 'activation', 'build', 'result'] as const;
export const TASKS = [
  { id: 'meeting-follow-up', title: 'Meeting follow-up', prompt: 'Prepare a meeting follow-up from the supplied notes for my review.', missing: 'connection' },
  { id: 'investor-update', title: 'Investor update', prompt: 'Draft an investor update from the supplied monthly metrics for my review.', missing: 'detail' },
  { id: 'competitor-brief', title: 'Competitor brief', prompt: 'Prepare a competitor brief from the supplied public research for my review.', missing: 'detail' },
] as const;
export const CORE = ['ON-B-01', 'ON-B-07', 'ON-B-08', 'ON-B-09', 'ON-B-10'];
export const FULL = [...CORE, 'ON-B-02', 'ON-B-03', 'ON-B-04', 'ON-B-05', 'ON-B-06', 'ON-B-11'];
export const RECOVERY = ['double-submit', 'changed-body', 'lost-acceptance', 'crash-before-save', 'crash-after-save', 'cancel-before-save', 'cancel-after-save', 'model-failure', 'timeout', 'unsupported-node', 'foreign-owner', 'deleted-result', 'finish-recheck'] as const;
export interface Case { id: string; kind: 'mocked' | 'manual' | 'real-provider'; requires: string[]; checks: string[]; suites?: string[]; }
export function requiredCases(): Case[] {
  const cases: Case[] = [];
  for (const task of TASKS) for (const prerequisite of ['satisfied', 'missing']) cases.push({ id: `task/${task.id}/${prerequisite}`, kind: 'mocked', requires: CORE, checks: ['truthful-result', 'persisted-disabled-draft', 'no-external-effects'] });
  for (const recovery of RECOVERY) cases.push({ id: `recovery/${recovery}`, kind: 'mocked', requires: CORE, checks: ['recovery-invariant', 'persisted-disabled-draft', 'no-external-effects'] });
  for (const journey of ['hosted', 'self-configured', 'skip-google-interview', 'tour-replay', 'explore-first']) cases.push({ id: `journey/${journey}`, kind: 'mocked', requires: FULL, checks: ['complete-provider-path', 'refresh-preserves-progress', 'persisted-disabled-draft', 'no-external-effects'] });
  const suite = (id: string, requires: string[], suites: string[]) => cases.push({ id, kind: 'mocked', requires, suites, checks: ['tests-executed', 'zero-failures', 'zero-skips'] });
  suite('compat/setup-and-permissions', ['ON-B-02'], ['src/onboarding-next/setup/provider.test.ts', 'src/onboarding-next/setup/permissions.test.ts']);
  suite('compat/google-callbacks', ['ON-B-03'], ['src/onboarding-next/google/provider.test.ts']);
  suite('recovery/interview-reconnect-save', ['ON-B-04', 'ON-B-05'], ['src/onboarding-next/interview-session/socket.integration.test.ts', 'src/onboarding-next/interview-profile/session.integration.test.ts']);
  suite('recovery/tour-refresh-two-tabs', ['ON-B-01', 'ON-B-06'], ['src/onboarding-next/tour/journey.integration.test.ts']);
  suite('recovery/build-fencing-and-timeout', CORE, ['src/onboarding-next/build-jobs/index.test.ts', 'src/onboarding-next/build-jobs/cancellation.test.ts']);
  suite('compat/runtime-empty-partial-revoked', ['ON-B-11'], ['src/onboarding-next/runtime/runtime.test.ts', 'src/onboarding-next/runtime/routes.test.ts']);
  suite('compat/redacted-diagnostics', ['ON-B-12'], ['src/onboarding-next/diagnostics/index.test.ts', 'src/onboarding-next/diagnostics/integration.test.ts']);
  suite('compat/ui-old-new-and-resume', ['ON-U-10', ...VIEWS.map((_, n) => `ON-U-${String(n + 1).padStart(2, '0')}`), ...FULL], ['ui/src/onboarding-next/host/transport.test.ts', 'ui/src/onboarding-next/host/runtime-compat.test.ts', 'ui/src/onboarding-next/host/Entry.test.tsx']);
  for (const id of ['hosted-browser', 'sidecar-webview', 'google-sandbox-callbacks', 'native-permission-recovery', 'deployed-old-new-pairs']) cases.push({ id: `staging/${id}`, kind: 'manual', requires: FULL, checks: ['actual-environment', 'observed-recovery', 'no-external-effects'] });
  for (const task of TASKS) for (const prerequisite of ['satisfied', 'missing']) cases.push({ id: `models/${task.id}/${prerequisite}`, kind: 'real-provider', requires: FULL, checks: ['supported-profiles', 'semantic-result', 'persisted-disabled-draft', 'no-external-effects', 'authorized-spend'] });
  return cases;
}
export const RELEASE_OWNERS = ['ON-U-10', 'ON-B-11', 'D', 'F', 'Q', 'release-owner'] as const;
