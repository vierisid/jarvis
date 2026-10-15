import { BRIEF_CONTRACT_VERSION, type BriefTimestamp } from './contracts.ts';
import type { BriefProvider } from './providers.ts';

/** Activation dependencies, not imports. Cross-track quality gates belong in provider readiness. */
export const BRIEF_CAPABILITIES = {
  conversations: [],
  chatTransport: ['conversations'],
  chatState: ['conversations', 'chatTransport'],
  chatAttachments: ['chatTransport'],
  chatProgress: ['chatTransport'],
  workflowComposition: [],
  compositionIngredients: ['workflowComposition'],
  preparedOpportunities: [], // Provider must also satisfy Q-13 before returning ready.
  opportunityActivation: ['preparedOpportunities'],
  quietAwareness: [],
  decisions: [],
  recommendations: ['decisions'], // Provider must also satisfy Q-18.
  decisionEdits: ['decisions'],
  goalMeasurements: [],
  outcomes: ['goalMeasurements'],
  memoryStream: ['memoryUsage'],
  memoryUsage: [],
  memoryForget: [],
  workflowRemoval: [],
  workflowContext: [],
  connections: [],
  profileSettings: [],
  hostedAccount: [],
  navigationCompatibility: [],
  onboarding: ['workflowComposition'],
  reconciliation: [],
} as const;
export type BriefCapabilityId = keyof typeof BRIEF_CAPABILITIES;
export const BRIEF_CAPABILITY_IDS = Object.keys(BRIEF_CAPABILITIES) as BriefCapabilityId[];

export interface BriefCapability {
  supported: boolean;
  ready: boolean;
  enabled: boolean;
  state: 'unsupported' | 'loading' | 'unavailable' | 'ready';
  reason: 'provider_missing' | 'provider_unavailable' | 'provider_loading' | 'disabled' | 'dependency_not_ready' | null;
}
export interface BriefCapabilitySnapshot {
  contractVersion: typeof BRIEF_CONTRACT_VERSION;
  asOf: BriefTimestamp;
  capabilities: Record<BriefCapabilityId, BriefCapability>;
}
/** Each future feature exports one registration from its own registrations/<feature>.ts file. */
export interface BriefRegistration {
  id: BriefCapabilityId;
  provider: BriefProvider;
}

/** Fixed feature table scoped to one daemon. No global registry, discovery or dynamic imports. */
export class BriefCapabilities {
  private readonly providers = new Map<BriefCapabilityId, BriefProvider>();
  private readonly enabled: ReadonlySet<BriefCapabilityId>;

  constructor(registrations: readonly BriefRegistration[] = [], enable: readonly BriefCapabilityId[] = []) {
    for (const { id, provider } of registrations) {
      if (!Object.hasOwn(BRIEF_CAPABILITIES, id)) throw new Error('Unknown Brief capability');
      if (this.providers.has(id)) throw new Error(`Duplicate Brief registration: ${id}`);
      if (!provider || typeof provider.readiness !== 'function') throw new Error(`Missing Brief provider: ${id}`);
      this.providers.set(id, provider);
    }
    if (enable.some(id => !Object.hasOwn(BRIEF_CAPABILITIES, id))) throw new Error('Unknown Brief activation');
    this.enabled = new Set(enable);
  }

  hasProvider(id: BriefCapabilityId, provider: BriefProvider): boolean {
    return this.providers.get(id) === provider;
  }

  snapshot(): BriefCapabilitySnapshot {
    const capabilities = {} as Record<BriefCapabilityId, BriefCapability>;
    const resolve = (id: BriefCapabilityId): BriefCapability => {
      if (capabilities[id]) return capabilities[id];
      const provider = this.providers.get(id);
      if (!provider) return capabilities[id] = {
        supported: false, ready: false, enabled: false, state: 'unsupported', reason: 'provider_missing',
      };
      // Only fixed status values reach the browser. Exceptions/credentials never do.
      let state: BriefCapability['state'] = 'unavailable';
      try {
        const value = provider.readiness();
        if (value === 'ready' || value === 'loading') state = value;
      } catch { /* A provider failure is unavailable, never an empty or ready result. */ }
      const ready = state === 'ready';
      const dependenciesReady = BRIEF_CAPABILITIES[id].every(dependency => resolve(dependency).enabled);
      const enabled = ready && this.enabled.has(id) && dependenciesReady;
      return capabilities[id] = {
        supported: true, ready, enabled, state,
        reason: !ready ? state === 'loading' ? 'provider_loading' : 'provider_unavailable'
          : !this.enabled.has(id) ? 'disabled' : !dependenciesReady ? 'dependency_not_ready' : null,
      };
    };
    for (const id of BRIEF_CAPABILITY_IDS) resolve(id);
    return { contractVersion: BRIEF_CONTRACT_VERSION, asOf: Date.now(), capabilities };
  }
}

/** Old/absent/unknown-major responses disable new actions; extra v1 fields are additive. */
export function isBriefCapabilityEnabled(snapshot: unknown, id: BriefCapabilityId): boolean {
  if (!Object.hasOwn(BRIEF_CAPABILITIES, id)) return false;
  if (!snapshot || typeof snapshot !== 'object') return false;
  const value = snapshot as Partial<BriefCapabilitySnapshot>;
  if (value.contractVersion !== BRIEF_CONTRACT_VERSION || !value.capabilities || typeof value.capabilities !== 'object') return false;
  if (!Object.hasOwn(value.capabilities, id)) return false;
  const capability = value.capabilities[id];
  return capability?.supported === true && capability.ready === true && capability.enabled === true
    && capability.state === 'ready' && capability.reason === null;
}
