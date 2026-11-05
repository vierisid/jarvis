import { randomUUID } from 'node:crypto';
import { ONBOARDING_ACCOUNTS, ONBOARDING_ACTION, ONBOARDING_PIECE, onboardingResource, onboardingSetup, onboardingCustomer, onboardingTransport, onboardCustomer, type OnboardingResolutionRecord, type ResourceBranch, type ResourceOutcome } from './customer-onboarding';
import { acquireOnboarding, OnboardingRecordError, readOnboardingRecord, recordedCustomerNames, resolveOnboardingBranch } from '../db/repos/customer-onboarding';
import { getFlowRunInProject } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { boundedReceiptText } from '../../roles/untrusted';
import { connectionBindings, enforceRunConnectionBinding, recordRunCredentialOutcome } from '../db/repos/binding-pins';
import { walkFlowNodes } from '../db/flow-graph';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import type { WorkflowEffectBoundary } from './effect-boundary';
import { managedConnectionMisuse, managedSourceFor, type CredentialResolver } from '../credentials/adapter';
import { ConnectionCredentialError, OAUTH2_TYPES } from '../credentials/pasted-oauth2';
import { isCustomerOnboardingStep, ONBOARDING_ACCOUNT_LABELS, type OnboardingAccountField } from '../onboarding-accounts';

/** The durable record of one customer's onboarding by one workflow. */
export function onboardingIdentity(projectId: string, flowId: string, customerId: string): string {
  return digest(['customer-onboarding', projectId, flowId, customerId]);
}

/**
 * A person's decision about an unknown onboarding branch of a run (#1243),
 * after checking ClickUp or Drive: `mark_done` (it was created, with the
 * resource's ID or link) or `release` (it was not; the next run for this
 * customer creates it).
 * Nothing is created or run here.
 */
export class OnboardingResolutionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); this.name = 'OnboardingResolutionError'; }
}
export function resolveOnboardingOutcome(projectId: string, runId: string, input: { effectId?: unknown; branch: unknown; resolution: unknown; resource?: unknown; note?: unknown },
  via: OnboardingResolutionRecord['via']): { customerId: string; branch: ResourceBranch; outcome: ResourceOutcome } {
  const bad = (message: string) => new OnboardingResolutionError(message, 400);
  const run = getFlowRunInProject(projectId, runId);
  if (!run) throw new OnboardingResolutionError(`run not found: ${runId}`, 404);
  if (input.branch !== 'clickup' && input.branch !== 'drive') throw bad('branch must be clickup or drive');
  if (input.resolution !== 'mark_done' && input.resolution !== 'release') throw bad('resolution must be mark_done (it was created) or release (it was not)');
  if (input.note !== undefined && (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000)) throw bad('A note must be 1-2000 characters');
  if (input.resolution === 'release' && input.resource !== undefined) throw bad('release takes no resource: it was not created');
  const effects = listWorkflowEffects(run.id).filter(e => e.route === 'customer-onboarding' && e.provenance.piece === ONBOARDING_PIECE);
  const chosen = input.effectId === undefined ? effects : effects.filter(e => e.id === input.effectId);
  if (chosen.length !== 1) throw chosen.length ? bad('This run onboarded several customers; name the effect_id to resolve')
    : new OnboardingResolutionError('No customer onboarding in this run', 404);
  const customer = (chosen[0]!.arguments as { customer?: { id?: unknown } }).customer;
  if (typeof customer?.id !== 'string' || !customer.id) throw new OnboardingResolutionError('The onboarding record names no customer', 409);
  const branch = input.branch;
  let decision: { created: { id: string; url: string } } | { created: false };
  try { decision = input.resolution === 'mark_done' ? { created: onboardingResource(branch, input.resource) } : { created: false }; }
  catch (e) { throw bad((e as Error).message); }
  try {
    const outcome = resolveOnboardingBranch(onboardingIdentity(chosen[0]!.projectId, run.flowId, customer.id), branch, decision,
      { at: Date.now(), via, ...(typeof input.note === 'string' ? { note: boundedReceiptText(input.note.trim(), 2000) } : {}) });
    return { customerId: customer.id, branch, outcome };
  } catch (e) {
    if (e instanceof OnboardingRecordError) throw new OnboardingResolutionError(e.message, e.status);
    throw e;
  }
}

/** One customer onboarded by a run, with what is on record now for its two branches (#1261). */
export interface RunOnboardingOutcome {
  effectId: string;
  customer: { id: string; name: string | null };
  /** A run holds this customer now: nothing can be resolved until it finishes. */
  running: boolean;
  branches: Partial<Record<ResourceBranch, { status: 'succeeded' | 'failed' | 'unknown' | 'dispatching'; url?: string; detail?: string }>>;
}
/**
 * The customer onboardings of a run, read-only, so the dashboard can offer the
 * same resolution as the route below for a branch still unknown (#1261). The
 * record is per customer, so this is its current state, which a later run or
 * an earlier decision may already have settled. A record that names no
 * customer is left out: it cannot be resolved.
 */
export function runOnboardingOutcomes(projectId: string, runId: string): RunOnboardingOutcome[] | null {
  const run = getFlowRunInProject(projectId, runId);
  if (!run) return null;
  return listWorkflowEffects(run.id).filter(e => e.route === 'customer-onboarding' && e.provenance.piece === ONBOARDING_PIECE).flatMap(effect => {
    const customer = (effect.arguments as { customer?: { id?: unknown; name?: unknown } }).customer;
    if (typeof customer?.id !== 'string' || !customer.id) return [];
    const record = readOnboardingRecord(onboardingIdentity(effect.projectId, run.flowId, customer.id));
    const branches: RunOnboardingOutcome['branches'] = {};
    for (const branch of ['clickup', 'drive'] as const) {
      const state = record?.results[branch];
      if (!state) continue;
      branches[branch] = state.status === 'dispatching' ? { status: 'dispatching' } : { status: state.status,
        ...(typeof state.url === 'string' ? { url: state.url } : {}),
        ...(typeof state.detail === 'string' ? { detail: boundedReceiptText(state.detail, 500) } : {}) };
    }
    return [{ effectId: effect.id, customer: { id: customer.id, name: typeof customer.name === 'string' ? boundedReceiptText(customer.name, 200) : null },
      running: record?.running ?? false, branches }];
  });
}

export function createOnboardingService(deps: { effects: WorkflowEffectBoundary; credentials: CredentialResolver; fetchImpl?: typeof fetch }) {
  return async (input: Record<string, unknown>, ctx: WorkflowEffectContext) => {
    const setup = onboardingSetup(input), customer = onboardingCustomer(setup, input.customer);
    const { run, version } = resolveEffectContext(ctx, ONBOARDING_PIECE, ONBOARDING_ACTION);
    const saved = walkFlowNodes(version.trigger).find(n => n.name === ctx.stepName);
    if (!saved || !isCustomerOnboardingStep(saved.type, saved.settings)) throw Error('Onboarding configuration must match a saved customer onboarding step');
    if (digest(onboardingSetup(saved.settings?.input ?? {})) !== digest(setup)) throw Error('Onboarding configuration must match the saved step');
    const reply = await deps.effects.invoke({ context: ctx, piece: ONBOARDING_PIECE, action: ONBOARDING_ACTION, route: 'customer-onboarding', toolName: 'workflow_customer_onboarding', category: 'write_data', toolCategory: 'workflow', request: { ...setup, customer },
      prepare: () => ({ arguments: { ...setup, customer }, target: { accounts: [setup.clickupConnection, setup.driveConnection], clickupListId: setup.clickupListId, driveParentId: setup.driveParentId, customerId: customer.id, effect: 'Create one onboarding task and one customer folder, independently' } }),
      execute: async (args, checkpoint) => {
        const s = onboardingSetup(args), c = args.customer as typeof customer;
        const fields = Object.keys(ONBOARDING_ACCOUNTS) as OnboardingAccountField[];
        // The readiness rule, for every account before any binding is checked, lease taken or
        // credential resolved: the saved step itself names the account, and a managed connection
        // is refused by managedConnectionMisuse (no exemption covers onboarding), so nothing is written.
        for (const field of fields) {
          const externalId = s[field];
          if (saved.settings?.input?.[field] !== externalId) throw Error('Onboarding account must match the saved workflow step');
          if (!connectionBindings(version.trigger).has(externalId)) throw Error('Onboarding account is not bound to this workflow');
          if (externalId.startsWith('jarvis:')) {
            const source = managedSourceFor(deps.credentials.list(), externalId);
            const misuse = source ? managedConnectionMisuse(source, ONBOARDING_ACCOUNTS[field], `settings.input.${field}`, saved.settings, saved.type) : 'Managed connection source is unavailable';
            if (misuse) throw Error(misuse);
          }
        }
        const identity = onboardingIdentity(ctx.projectId, run.flowId, c.id);
        // Keyed on the setup and the customer ID only (#1243): a corrected name does not block the customer.
        // A record an earlier release made is moved over when it still matches.
        // Its configuration then included the customer's name: any name this workflow recorded for this ID
        // (a record blocked by a rename before the fix included) still matches when the setup is the same.
        // Read only for a row that does not already match.
        const lease = acquireOnboarding(identity, digest(['customer-onboarding-config-v2', s, c.id]), randomUUID(), Date.now,
          () => [...new Set([c.name, ...recordedCustomerNames(ctx.projectId, run.flowId, c.id)])].map(name => digest([s, { id: c.id, name }])));
        const check = () => { checkpoint(); lease.store.check(); };
        try {
          // An account problem fails only its own branch, before dispatch, so a later run may retry it.
          const create = onboardingTransport(s, c, async branch => {
            const field: OnboardingAccountField = branch === 'clickup' ? 'clickupConnection' : 'driveConnection', externalId = s[field], pieceName = ONBOARDING_ACCOUNTS[field];
            check();
            const refusal = enforceRunConnectionBinding(ctx.runId,ctx.projectId,externalId,deps.credentials);
            if (refusal) throw Error(refusal);
            let resolved = await deps.credentials.resolve({ projectId: ctx.projectId, pieceName, externalId });
            if (resolved?.pieceName && resolved.pieceName !== pieceName) throw Error('Onboarding account belongs to a different provider');
            if (!resolved || resolved.type !== 'OAUTH2' || resolved.status && resolved.status !== 'ACTIVE') throw Error('Connect the selected OAuth2 account securely');
            // A stored OAuth2 token is refreshed when it is about to expire, only
            // after the run's binding check passed (as the engine's connection route does).
            try { resolved = await deps.credentials.fresh(resolved); }
            catch (error) {
              if (!(error instanceof ConnectionCredentialError)) throw error;
              // Typed on the run's binding, as the engine's connection route records it.
              recordRunCredentialOutcome(ctx.runId, externalId, { code: error.code, message: error.message });
              throw Error(`Nothing was created: the selected ${ONBOARDING_ACCOUNT_LABELS[field]} account (${externalId}) could not be refreshed`);
            }
            if (resolved.stored && OAUTH2_TYPES.has(resolved.type)) recordRunCredentialOutcome(ctx.runId, externalId, null);
            if (typeof resolved.value.access_token !== 'string' || !resolved.value.access_token) throw Error('Connect the selected OAuth2 account securely');
            check();
            return resolved.value.access_token;
          }, check, deps.fetchImpl);
          return await onboardCustomer(lease.store,create,identity,check);
        } finally { lease.release(); }
      } });
    return reply.approval ? { approval: reply.approval } : reply.result;
  };
}
