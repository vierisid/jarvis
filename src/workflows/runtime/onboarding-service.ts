import { randomUUID } from 'node:crypto';
import { ONBOARDING_ACCOUNTS, ONBOARDING_ACTION, ONBOARDING_PIECE, onboardingSetup, onboardingCustomer, onboardingTransport, onboardCustomer } from './customer-onboarding';
import { acquireOnboarding } from '../db/repos/customer-onboarding';
import { connectionBindings, enforceRunConnectionBinding, recordRunCredentialOutcome } from '../db/repos/binding-pins';
import { walkFlowNodes } from '../db/flow-graph';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import type { WorkflowEffectBoundary } from './effect-boundary';
import { managedConnectionMisuse, managedSourceFor, type CredentialResolver } from '../credentials/adapter';
import { ConnectionCredentialError, OAUTH2_TYPES } from '../credentials/pasted-oauth2';
import { isCustomerOnboardingStep, ONBOARDING_ACCOUNT_LABELS, type OnboardingAccountField } from '../onboarding-accounts';

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
        const identity = digest(['customer-onboarding', ctx.projectId, run.flowId, c.id]);
        const lease = acquireOnboarding(identity, digest([s,c]), randomUUID());
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
