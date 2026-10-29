import { REPORT_PIECE } from './weekly-report';
import { QUARTERLY_ACTION, quarterlySetup, quarterlyTransport, collectQuarterlyReport } from './quarterly-report';
import { fireForRun } from '../db/repos/trigger-fire';
import { connectionBindings, enforceRunConnectionBinding } from '../db/repos/binding-pins';
import { walkFlowNodes } from '../db/flow-graph';
import { digest, resolveEffectContext, type WorkflowEffectContext } from './effect-context';
import type { WorkflowEffectBoundary } from './effect-boundary';
import type { CredentialResolver } from '../credentials/adapter';

export function createQuarterlyReportService(deps: { effects: WorkflowEffectBoundary; credentials: CredentialResolver; fetchImpl?: typeof fetch }) {
  return async (input: Record<string, unknown>, ctx: WorkflowEffectContext) => {
    const setup = quarterlySetup(input), { version } = resolveEffectContext(ctx, REPORT_PIECE, QUARTERLY_ACTION);
    const saved = walkFlowNodes(version.trigger).find(n => n.name === ctx.stepName)!;
    if (digest(quarterlySetup(saved.settings?.input ?? {})) !== digest(setup)) throw Error('Quarterly setup must match saved workflow');
    if (version.trigger.settings?.pieceName !== 'schedule' || saved.settings?.input?.scheduledFor !== `{{${version.trigger.name}.scheduledFor}}`) throw Error('Quarterly report must use the persisted schedule occurrence');
    const fire = fireForRun(ctx.runId);
    if (!fire || fire.source !== 'schedule' || !Number.isFinite(fire.scheduledFor) || fire.scheduledFor === null) throw Error('Scheduled occurrence unavailable; no execution-time fallback');
    const scheduledFor = new Date(fire.scheduledFor).toISOString();
    if (typeof input.scheduledFor !== 'string' || Date.parse(input.scheduledFor) !== fire.scheduledFor) throw Error('Quarterly occurrence does not match admitted trigger');
    const reply = await deps.effects.invoke({ context: ctx, piece: REPORT_PIECE, action: QUARTERLY_ACTION, route: 'quarterly-report',
      toolName: 'workflow_quarterly_report', category: 'read_data', toolCategory: 'reports', request: { ...setup, scheduledFor },
      prepare: () => ({ arguments: { ...setup, scheduledFor }, target: { account: setup.hubspotConnection, portal: setup.hubspotPortalId, effect: 'Read closed HubSpot deals and return currency-separated quarterly summary. No provider writes.' } }),
      execute: async (args, checkpoint) => {
        const s = quarterlySetup(args), externalId = s.hubspotConnection, pieceName = '@activepieces/piece-hubspot';
        const check = () => { checkpoint(); const refusal = enforceRunConnectionBinding(ctx.runId, ctx.projectId, externalId, deps.credentials); if (refusal) throw Error(refusal); };
        check();
        if (!connectionBindings(version.trigger).has(externalId)) throw Error('Quarterly account not bound');
        const resolved = await deps.credentials.resolve({ projectId: ctx.projectId, pieceName, externalId });
        const token = resolved?.type === 'OAUTH2' ? resolved.value.access_token : undefined;
        if (externalId.startsWith('jarvis:') || resolved?.pieceName && resolved.pieceName !== pieceName || resolved?.status && resolved.status !== 'ACTIVE' || typeof token !== 'string' || !token) throw Error('Connect the selected HubSpot OAuth account securely before running');
        check();
        return collectQuarterlyReport(s, quarterlyTransport(token, check, deps.fetchImpl), scheduledFor, check);
      } });
    return reply.approval ? { approval: reply.approval } : reply.result;
  };
}
