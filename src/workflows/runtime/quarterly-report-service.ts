import { REPORT_PIECE } from './weekly-report';
import { QUARTERLY_ACTION, QUARTERLY_MANAGED_REFUSAL, quarterlySetup, quarterlyTransport, collectQuarterlyReport } from './quarterly-report';
import { fireForRun } from '../db/repos/trigger-fire';
import { connectionBindings, enforceRunConnectionBinding, recordRunCredentialOutcome } from '../db/repos/binding-pins';
import { walkFlowNodes } from '../db/flow-graph';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import type { WorkflowEffectBoundary } from './effect-boundary';
import type { CredentialResolver } from '../credentials/adapter';
import { ConnectionCredentialError, OAUTH2_TYPES } from '../credentials/pasted-oauth2';
import { getCronTimezone } from '../../lib/cron-scheduler';

export function createQuarterlyReportService(deps: { effects: WorkflowEffectBoundary; credentials: CredentialResolver; fetchImpl?: typeof fetch }) {
  return async (input: Record<string, unknown>, ctx: WorkflowEffectContext) => {
    const setup = quarterlySetup(input), { version } = resolveEffectContext(ctx, REPORT_PIECE, QUARTERLY_ACTION);
    const saved = walkFlowNodes(version.trigger).find(n => n.name === ctx.stepName);
    if (!saved || saved.type !== 'PIECE' || saved.settings?.pieceName !== REPORT_PIECE || saved.settings?.actionName !== QUARTERLY_ACTION) throw Error('Quarterly configuration must match a saved quarterly report step');
    if (digest(quarterlySetup(saved.settings?.input ?? {})) !== digest(setup)) throw Error('Quarterly setup must match saved workflow');
    if (version.trigger.settings?.pieceName !== 'schedule' || saved.settings?.input?.scheduledFor !== `{{${version.trigger.name}.scheduledFor}}`) throw Error('Quarterly report must use the persisted schedule occurrence');
    // Quarters are Rome calendar quarters; a schedule in another zone could start on a different Rome date.
    const tz = version.trigger.settings?.input?.timezone;
    if ((typeof tz === 'string' && tz.trim() ? tz : getCronTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone) !== setup.timezone) throw Error(`Quarterly report requires the schedule timezone ${setup.timezone}`);
    const fire = fireForRun(ctx.runId);
    if (!fire || fire.source !== 'schedule' || !Number.isFinite(fire.scheduledFor) || fire.scheduledFor === null) throw Error('Scheduled occurrence unavailable; no execution-time fallback');
    const scheduledFor = new Date(fire.scheduledFor).toISOString();
    if (typeof input.scheduledFor !== 'string' || Date.parse(input.scheduledFor) !== fire.scheduledFor) throw Error('Quarterly occurrence does not match admitted trigger');
    const reply = await deps.effects.invoke({ context: ctx, piece: REPORT_PIECE, action: QUARTERLY_ACTION, route: 'quarterly-report',
      toolName: 'workflow_quarterly_report', category: 'read_data', toolCategory: 'reports', request: { ...setup, scheduledFor },
      prepare: () => ({ arguments: { ...setup, scheduledFor }, target: { account: setup.hubspotConnection, portal: setup.hubspotPortalId, effect: 'Read closed HubSpot deals and return currency-separated quarterly summary. No provider writes.' } }),
      execute: async (args, checkpoint) => {
        const s = quarterlySetup(args), externalId = s.hubspotConnection, pieceName = '@activepieces/piece-hubspot';
        // The saved step names the account, and no managed connection is accepted: refused before any binding or credential read.
        if (saved.settings?.input?.hubspotConnection !== externalId) throw Error('Quarterly account must match the saved workflow step');
        if (!connectionBindings(version.trigger).has(externalId)) throw Error('Quarterly account not bound');
        if (externalId.startsWith('jarvis:')) throw Error(QUARTERLY_MANAGED_REFUSAL);
        const check = () => { checkpoint(); const refusal = enforceRunConnectionBinding(ctx.runId, ctx.projectId, externalId, deps.credentials); if (refusal) throw Error(refusal); };
        check();
        let resolved = await deps.credentials.resolve({ projectId: ctx.projectId, pieceName, externalId });
        if (!resolved || resolved.pieceName && resolved.pieceName !== pieceName || resolved.type !== 'OAUTH2' || resolved.status && resolved.status !== 'ACTIVE') throw Error('Connect the selected HubSpot OAuth account securely before running');
        // A stored OAuth2 token about to expire is refreshed, only after the run's binding check passed.
        try { resolved = await deps.credentials.fresh(resolved); }
        catch (error) {
          if (!(error instanceof ConnectionCredentialError)) throw error;
          recordRunCredentialOutcome(ctx.runId, externalId, { code: error.code, message: error.message });
          const account = `the selected HubSpot account (${externalId})`;
          throw Error(error.code === 'CONNECTION_EXPIRED' ? `Reconnect ${account}: ${error.message}`
            : error.code === 'CONNECTION_REFRESH_UNREACHABLE' ? `Nothing was read: Jarvis could not refresh ${account} just now, which is usually temporary. Start a new run later. ${error.message}`
            : `Nothing was read: ${account} changed while Jarvis refreshed it. Start a new run. ${error.message}`);
        }
        if (resolved.stored && OAUTH2_TYPES.has(resolved.type)) recordRunCredentialOutcome(ctx.runId, externalId, null);
        const token = resolved.type === 'OAUTH2' ? resolved.value.access_token : undefined;
        if (typeof token !== 'string' || !token) throw Error('Connect the selected HubSpot OAuth account securely before running');
        check();
        return collectQuarterlyReport(s, quarterlyTransport(token, check, deps.fetchImpl), scheduledFor, check);
      } });
    return reply.approval ? { approval: reply.approval } : reply.result;
  };
}
