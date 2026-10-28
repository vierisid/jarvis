import { randomUUID } from 'node:crypto';
import { ONBOARDING_ACCOUNTS, ONBOARDING_ACTION, ONBOARDING_PIECE, onboardingSetup, onboardingCustomer, onboardingTransport, onboardCustomer } from './customer-onboarding';
import { acquireOnboarding } from '../db/repos/customer-onboarding';
import { connectionBindings, enforceRunConnectionBinding } from '../db/repos/binding-pins';
import { walkFlowNodes } from '../db/flow-graph';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import type { WorkflowEffectBoundary } from './effect-boundary';
import type { CredentialResolver } from '../credentials/adapter';

export function createOnboardingService(deps: { effects: WorkflowEffectBoundary; credentials: CredentialResolver; fetchImpl?: typeof fetch }) {
  return async (input: Record<string, unknown>, ctx: WorkflowEffectContext) => {
    const setup = onboardingSetup(input), customer = onboardingCustomer(setup, input.customer);
    const { run, version } = resolveEffectContext(ctx, ONBOARDING_PIECE, ONBOARDING_ACTION);
    const saved = walkFlowNodes(version.trigger).find(n => n.name === ctx.stepName)!;
    if (digest(onboardingSetup(saved.settings?.input ?? {})) !== digest(setup)) throw Error('Onboarding configuration must match the saved step');
    const reply = await deps.effects.invoke({ context: ctx, piece: ONBOARDING_PIECE, action: ONBOARDING_ACTION, route: 'customer-onboarding', toolName: 'workflow_customer_onboarding', category: 'write_data', toolCategory: 'workflow', request: { ...setup, customer },
      prepare: () => ({ arguments: { ...setup, customer }, target: { accounts: [setup.clickupConnection, setup.driveConnection], clickupListId: setup.clickupListId, driveParentId: setup.driveParentId, customerId: customer.id, effect: 'Create one onboarding task and one customer folder, independently' } }),
      execute: async (args, checkpoint) => {
        const s = onboardingSetup(args), c = args.customer as typeof customer;
        const identity = digest(['customer-onboarding', ctx.projectId, run.flowId, c.id]);
        const lease = acquireOnboarding(identity, digest([s,c]), randomUUID());
        const check = () => { checkpoint(); lease.store.check(); };
        try {
          const create = onboardingTransport(s, c, async branch => {
            const field = branch === 'clickup' ? 'clickupConnection' : 'driveConnection', externalId = s[field], pieceName = ONBOARDING_ACCOUNTS[field];
            if (!connectionBindings(version.trigger).has(externalId)) throw Error('Account is not bound to this workflow');
            check();
            const refusal = enforceRunConnectionBinding(ctx.runId,ctx.projectId,externalId,deps.credentials);
            if (refusal) throw Error(refusal);
            const resolved = await deps.credentials.resolve({ projectId: ctx.projectId, pieceName, externalId });
            const google = externalId === 'jarvis:google' || externalId.startsWith('jarvis:google:');
            if (externalId.startsWith('jarvis:') && !(branch === 'drive' && google) || resolved?.pieceName && resolved.pieceName !== pieceName) throw Error('Account belongs to another provider');
            if (!resolved || resolved.type !== 'OAUTH2' || resolved.status && resolved.status !== 'ACTIVE' || typeof resolved.value.access_token !== 'string' || !resolved.value.access_token) throw Error('Connect the selected OAuth2 account securely');
            check();
            return resolved.value.access_token;
          }, check, deps.fetchImpl);
          return await onboardCustomer(lease.store,create,identity);
        } finally { lease.release(); }
      } });
    return reply.approval ? { approval: reply.approval } : reply.result;
  };
}
