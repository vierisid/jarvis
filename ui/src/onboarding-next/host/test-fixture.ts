import type { Configuration, FeatureAdapter, Journey, Status, ViewModule } from './contract.ts';
import { PROVIDERS, VIEWS } from './contract.ts';
export function fixture() {
  const calls: string[] = [];
  let journey: Journey = {
    schemaVersion: 1, scopeId: 'fixture-owner-project', journeyId: 'journey', revision: 0, stepId: 'welcome',
    setupState: 'pending', interviewState: 'connecting', tourState: 'pending', tourStepId: null,
    activationState: 'pending', completion: 'active', jobId: null, draft: null,
  };
  const status: Status = { schemaVersion: 1, installMode: 'hosted', supported: true, ready: true, enabled: true, released: true, reason: 'ready',
    capabilities: Object.fromEntries(PROVIDERS.map(id => [id, { present: true, registered: true, supported: true, ready: true, reason: 'ready' }])) };
  const models: Record<string, Record<string, unknown>> = {};
  const modules: ViewModule[] = VIEWS.map(spec => ({ manifest: { schemaVersion: 1, id: spec.id, kind: 'view', entry: './index.tsx', provides: [spec.capability], requires: [...spec.requires] },
    load: async () => { calls.push(`load:${spec.directory}`); return { [spec.exportName]: () => null }; } }));
  const config: Configuration = {
    enabled: true, candidate: { frontend: 'fixture-ui', backend: 'fixture-server', sidecar: 'fixture-sidecar' }, authorizeRelease: () => true,
    modules, adapters: Object.fromEntries([...VIEWS.filter(v => !['welcome', 'explainer'].includes(v.directory)).map(v => v.directory), 'legacy-provider-setup'].map(name => [name, {
      available: () => true,
      create: (): FeatureAdapter => ({ available: () => true,
        read: async () => ({ model: models[name] ?? {} }),
        command: async (_ctx, action) => { calls.push(`${name}:${action}`); },
        setDraft: (_ctx, draft) => { models[name] = { ...models[name], draft }; return { model: models[name]! }; },
      }),
    }])),
    transport: {
      status: async () => { calls.push('status'); return structuredClone(status); },
      call: async (operation, input) => {
        calls.push(operation);
        if (operation === 'setup.complete') { journey = { ...journey, setupState: 'completed', revision: journey.revision + 1 }; return { ready: true }; }
        if (operation === 'journey.transition') {
          if (input.expectedRevision !== journey.revision || input.journeyId !== journey.journeyId) return { availability: 'unavailable', reason: 'conflict' };
          const c = input.command as { type: string; stepId: Journey['stepId'] };
          if (c.type === 'navigate') journey = { ...journey, stepId: c.stepId, revision: journey.revision + 1 };
          else if (c.type === 'explore' || c.type === 'finish') journey = { ...journey, stepId: 'exited', completion: c.type === 'explore' ? 'explored' : 'completed', revision: journey.revision + 1 };
          else if (c.type === 'replay_tutorial') journey = { ...journey, stepId: 'tour', revision: journey.revision + 1 };
        }
        return { availability: 'ready', snapshot: structuredClone(journey) };
      },
    },
  };
  return { config, status, models, calls, journey: () => journey, setJourney: (patch: Partial<Journey>) => { journey = { ...journey, ...patch }; } };
}
