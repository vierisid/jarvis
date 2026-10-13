import { BRIEF_CAPABILITIES, BRIEF_CAPABILITY_IDS, BriefCapabilities, isBriefCapabilityEnabled,
  type BriefCapabilityId, type BriefCapabilitySnapshot, type BriefRegistration } from '../capabilities';

export const RELEASE_CARDS = Array.from({ length: 27 }, (_, i) => `F-${String(i + 1).padStart(2, '0')}`);
export const COMPATIBILITY_CHECKS = ['fresh', 'upgrade', 'old_client', 'flag_rollback', 'host_bindings'] as const;
export type Deployment = 'self_hosted' | 'hosted';
export interface ReleaseRuntime { revision: string; deployment: Deployment; hostingRevision?: string }
export interface ReleaseRecord {
  version: 1;
  revision: string;
  deployment: Deployment;
  hostingRevision?: string;
  approvedCapabilities: BriefCapabilityId[];
  rollback: 'feature_flags' | 'previous_binary';
  prs: Array<{ card: string; repository: string; number: number; head: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeCommit: string | null }>;
  checks: Record<string, { status: 'passed' | 'failed' | 'blocked' | 'not_run'; revision: string;
    hostingRevision?: string; evidence: string }>;
}

/** Feature families must have their complete provider/host bundle, independently of the visual shell. */
export const ACTIVATION_MATRIX = {
  multiChat: { actions: ['chatTransport', 'chatState'], requires: ['conversations', 'chatTransport', 'chatState'] },
  preparedOpportunities: { actions: ['preparedOpportunities', 'opportunityActivation'],
    requires: ['workflowComposition', 'compositionIngredients', 'preparedOpportunities', 'opportunityActivation'] },
  metrics: { actions: ['outcomes'], requires: ['goalMeasurements', 'outcomes'] },
  reversibleRemoval: { actions: ['workflowRemoval'], requires: ['workflowRemoval', 'workflowContext', 'reconciliation'] },
} as const satisfies Record<string, { actions: readonly BriefCapabilityId[]; requires: readonly BriefCapabilityId[] }>;

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const capability = (v: unknown): v is BriefCapabilityId => typeof v === 'string' && Object.hasOwn(BRIEF_CAPABILITIES, v);
function validRecord(v: unknown): v is ReleaseRecord {
  return object(v) && v.version === 1 && sha(v.revision) && ['self_hosted', 'hosted'].includes(v.deployment)
    && (v.hostingRevision === undefined || sha(v.hostingRevision))
    && ['feature_flags', 'previous_binary'].includes(v.rollback)
    && Array.isArray(v.approvedCapabilities) && v.approvedCapabilities.every(capability)
    && new Set(v.approvedCapabilities).size === v.approvedCapabilities.length
    && Array.isArray(v.prs) && v.prs.every((p: unknown) => object(p) && RELEASE_CARDS.includes(p.card)
      && p.repository === (p.card === 'F-24' ? 'usejarvis/hosting' : 'vierisid/jarvis')
      && Number.isSafeInteger(p.number) && p.number > 0 && sha(p.head)
      && ['OPEN', 'CLOSED', 'MERGED'].includes(p.state) && (p.mergeCommit === null || sha(p.mergeCommit)))
    && new Set(v.prs.map((p: any) => p.card)).size === v.prs.length
    && object(v.checks) && Object.values(v.checks).every(c => object(c)
      && ['passed', 'failed', 'blocked', 'not_run'].includes(c.status) && sha(c.revision)
      && (c.hostingRevision === undefined || sha(c.hostingRevision))
      && typeof c.evidence === 'string' && c.evidence.trim().length > 0);
}

export interface ReleaseAssessment {
  status: 'blocked' | 'ready';
  /** Technical eligibility only; this module never authorizes or performs deployment. */
  deploymentAuthorized: false;
  blockers: string[];
  capabilities: Record<BriefCapabilityId, { enabled: boolean; blockers: string[] }>;
}

/** The runtime identity is supplied by the release owner, never inferred from a shell URL/flag. */
export function assessRelease(record: unknown, snapshot: unknown, runtime: ReleaseRuntime): ReleaseAssessment {
  const blockers: string[] = [];
  const valid = validRecord(record);
  if (!valid) blockers.push('invalid_or_missing_release_record');
  else {
    if (record.revision !== runtime.revision || record.deployment !== runtime.deployment) blockers.push('runtime_mismatch');
    if (runtime.deployment === 'hosted' && (!sha(runtime.hostingRevision) || record.hostingRevision !== runtime.hostingRevision))
      blockers.push('hosting_revision_mismatch');
    for (const card of RELEASE_CARDS) {
      const pr = record.prs.find(p => p.card === card);
      if (!pr || pr.state !== 'MERGED' || !pr.mergeCommit) blockers.push(`pr_not_merged:${card}`);
    }
    for (const check of [...COMPATIBILITY_CHECKS, ...(runtime.deployment === 'hosted' ? ['hosted_pair'] : []),
      ...(record.rollback === 'previous_binary' ? ['binary_rollback'] : [])]) {
      const result = record.checks[check];
      if (!result || result.status !== 'passed' || result.revision !== runtime.revision
        || (check === 'hosted_pair' && result.hostingRevision !== runtime.hostingRevision)) blockers.push(`check_not_passed:${check}`);
    }
  }
  const approved = new Set(valid ? record.approvedCapabilities : []);
  const requirements = (id: BriefCapabilityId, seen = new Set<BriefCapabilityId>()): Set<BriefCapabilityId> => {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const dependency of BRIEF_CAPABILITIES[id]) requirements(dependency, seen);
    for (const group of Object.values(ACTIVATION_MATRIX)) {
      if ((group.actions as readonly BriefCapabilityId[]).includes(id)) for (const member of group.requires) requirements(member, seen);
    }
    return seen;
  };
  const capabilities = {} as ReleaseAssessment['capabilities'];
  for (const id of BRIEF_CAPABILITY_IDS) {
    const reasons = [...blockers];
    for (const dependency of requirements(id)) {
      if (!approved.has(dependency)) reasons.push(`not_approved:${dependency}`);
      if (!isBriefCapabilityEnabled(snapshot, dependency)) reasons.push(`provider_not_enabled:${dependency}`);
      if (dependency === 'hostedAccount' && runtime.deployment !== 'hosted') reasons.push('unsupported_deployment:hostedAccount');
    }
    capabilities[id] = { enabled: reasons.length === 0, blockers: reasons };
  }
  return { status: blockers.length || [...approved].some(id => !capabilities[id].enabled) ? 'blocked' : 'ready',
    deploymentAuthorized: false, blockers, capabilities };
}

/** Opt-in release assembly seam. Existing F-01 module construction stays independently testable.
 * Missing records fail closed. Re-read both the record and provider readiness on every request.
 * D-33/release integration must use this registry for the same routes and shared chat transport. */
export class BriefReleaseCapabilities extends BriefCapabilities {
  constructor(registrations: readonly BriefRegistration[], requested: readonly BriefCapabilityId[],
    private runtime: ReleaseRuntime, private readRecord: () => unknown = () => undefined) {
    super(registrations, requested);
  }
  private record(): unknown { try { return this.readRecord(); } catch { return undefined; } }
  assessment() { return assessRelease(this.record(), super.snapshot(), this.runtime); }
  override snapshot(): BriefCapabilitySnapshot {
    const snapshot = super.snapshot(), report = assessRelease(this.record(), snapshot, this.runtime);
    for (const id of BRIEF_CAPABILITY_IDS) if (snapshot.capabilities[id].enabled && !report.capabilities[id].enabled) {
      snapshot.capabilities[id] = { ...snapshot.capabilities[id], enabled: false, reason: 'dependency_not_ready' };
    }
    return snapshot;
  }
}
