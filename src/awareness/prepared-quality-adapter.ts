import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AuthorityEngine } from '../authority/engine';
import type { ToolDefinition } from '../actions/tools/registry';
import type { ExecutionTarget } from '../util/execution-environment';
import type { CredentialResolver } from '../workflows/credentials/adapter';
import type { BriefBinding } from '../brief/contracts';
import type { PreparedAssessment, PreparedIdentity, PreparedQualification, PreparedQualificationGate } from './prepared-contracts';

interface QualityFacts {
  bindings: Array<{ kind: 'connection' | 'target'; id: string; revision: string | null; availability: 'ready' | 'unavailable' | 'unknown' }>;
  steps: Array<{ step: string; role: 'source' | 'effect'; decision: string }>;
  version: { dry: string | null } | null;
}
export interface SandboxFixture { id: string; payload: unknown; replies?: Record<string, string>; tools?: Record<string, unknown>; context?: Record<string, unknown> }
interface Sample { simulated: Array<{ step: string }>; [key: string]: unknown }
interface DryRunner { run(flowId: string, versionId: string, fixture: SandboxFixture): Promise<Sample>; close(): Promise<void> }
/** Narrow structural seam for Q-13. The optional implementation owns all qualification rules. */
export interface PreparedQualityModule {
  QUALIFIER: string;
  JOB_CONSTRAINTS: Record<string, unknown[]>;
  liveQualificationServices(options: QualityOptions): unknown;
  observePreparedProposal(request: Record<string, unknown>, services: unknown): QualityFacts;
  briefBindings(facts: QualityFacts['bindings']): BriefBinding[];
  qualifyPreparedProposal(request: Record<string, unknown>, services: unknown): PreparedQualification;
  recheckQualification(previous: PreparedQualification, request: Record<string, unknown>, services: unknown): { current: PreparedQualification; stale: boolean };
}
export interface QualityOptions {
  authority: AuthorityEngine | null; tool(name: string): ToolDefinition | null;
  targets(): Array<ExecutionTarget & { unavailableCapabilities?: string[] }>;
  credentials?: CredentialResolver;
}
export function createPreparedQualityAdapter(quality: PreparedQualityModule, options: QualityOptions, runner?: DryRunner,
  fixture: (identity: PreparedIdentity) => SandboxFixture | null = () => ({ id: 'prepared-empty-v1', payload: {} })): PreparedQualificationGate {
  const services = quality.liveQualificationServices(options);
  let closed = false;
  return {
    readiness: () => !closed && quality.QUALIFIER === 'prepared-qualification-v1',
    async prepare(identity): Promise<PreparedAssessment> {
      if (closed) throw Error('Qualification is closed');
      const spec = identity.specification;
      const constraints = structuredClone(quality.JOB_CONSTRAINTS[spec.kind]);
      if (!Array.isArray(constraints)) throw Error('No constraints for this job kind');
      if (spec.customConstraints) constraints.push({ kind: 'unverified', text: `${spec.description}\n${spec.expectedOutcome}` });
      const request: Record<string, unknown> = { proposalId: identity.proposalId, revision: identity.revision,
        evidence: spec.evidence, goal: spec.goal && { goalId: spec.goal.goalId, revision: spec.goal.revision },
        compositionId: identity.compositionId, workflow: identity.workflow, bindings: [], constraints, preview: null, sample: null };
      const facts = quality.observePreparedProposal(request, services);
      request.bindings = quality.briefBindings(facts.bindings);
      const input = fixture(identity);
      let sample: Sample | null = null;
      if (facts.version?.dry === null && runner && input) sample = await runner.run(identity.workflow.flowId, identity.workflow.versionId, input);
      const basis = sample ? 'sandbox_sample' as const : 'illustrative_template' as const;
      request.sample = sample;
      request.preview = { basis, runId: null, effects: facts.steps.filter(s => s.role === 'effect').map(s => ({
        step: s.step, approval: s.decision === 'approval' ? 'asks_first' : 'runs_automatically',
        sample: sample?.simulated.some(done => done.step === s.step) ? 'simulated' : 'none',
      })) };
      return { request, qualification: quality.qualifyPreparedProposal(request, services), previewBasis: basis };
    },
    recheck: assessment => {
      if (closed) throw Error('Qualification is closed');
      return quality.recheckQualification(assessment.qualification, assessment.request, services);
    },
    async close() { closed = true; await runner?.close(); },
  };
}

/** Fixed optional Q-13 files, not a plugin search or a caller-selected module. Missing means unavailable. */
export async function loadPreparedQualityGate(options: QualityOptions, bundlePath?: string): Promise<PreparedQualificationGate | null> {
  const qualificationPath = new URL('./prepared-qualification.ts', import.meta.url);
  const dryPath = new URL('./prepared-dry-run.ts', import.meta.url);
  if (!existsSync(fileURLToPath(qualificationPath)) || !existsSync(fileURLToPath(dryPath)) || !bundlePath) return null;
  let runner: DryRunner | undefined;
  try {
    const quality = await import(qualificationPath.href);
    const dry = await import(dryPath.href);
    if (quality.QUALIFIER !== 'prepared-qualification-v1' || !quality.JOB_CONSTRAINTS
      || ['liveQualificationServices','observePreparedProposal','briefBindings','qualifyPreparedProposal','recheckQualification'].some(name => typeof quality[name] !== 'function')
      || typeof dry.PreparedDryRunner?.start !== 'function') return null;
    runner = await dry.PreparedDryRunner.start(bundlePath);
    return createPreparedQualityAdapter(quality as PreparedQualityModule, options, runner);
  } catch { await runner?.close(); return null; }
}
