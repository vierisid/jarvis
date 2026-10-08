/**
 * What changing the emergency state does, in one place the daemon's state
 * callback and the tests share (Q-08, owner decision: Pause holds, Kill
 * stops).
 *
 *  - Every change: the engine's copy of the state follows the controller (it
 *    used to be the boot snapshot, which kept workflows blocked after Resume),
 *    and the change is audited.
 *  - Kill: every unfinished workflow run is stopped, saying why, and every
 *    pending approval is denied, so nothing raised before the Kill runs after
 *    Reset. Tools in flight stop at their next dispatch checkpoint
 *    (actions/tools/registry.ts).
 *  - Back to normal (Resume, Reset): workflow steps held while paused are
 *    released.
 */
import type { ApprovalManager, ApprovalRequest } from '../authority/approval.ts';
import type { AuditTrail } from '../authority/audit.ts';
import type { EmergencyState } from '../authority/emergency.ts';
import type { AuthorityEngine } from '../authority/engine.ts';
import { stopUnfinishedRunsForKill } from '../workflows/runtime/emergency-hold.ts';
import { releaseEmergencyHolds } from '../workflows/runtime/continuation.ts';

export interface EmergencyStateDeps {
  authorityEngine: Pick<AuthorityEngine, 'getConfig' | 'updateConfig'>;
  approvalManager: Pick<ApprovalManager, 'denyAllPending'>;
  auditTrail?: Pick<AuditTrail, 'log'> | null;
  /** Each request a Kill denied, for the dashboard to drop its card. */
  onApprovalDenied?: (request: ApprovalRequest) => void;
}

export function applyEmergencyState(state: EmergencyState, deps: EmergencyStateDeps): {
  stoppedRuns: number; deniedApprovals: number; releasedHolds: number;
} {
  deps.authorityEngine.updateConfig({ ...deps.authorityEngine.getConfig(), emergency_state: state });
  try {
    deps.auditTrail?.log({ agent_id: 'system', agent_name: 'Emergency control', tool_name: `emergency_${state}`,
      action_category: 'modify_settings', authority_decision: 'allowed', approval_id: null, executed: true, channel: 'system' });
  } catch (err) {
    console.error('[Emergency] could not audit the state change:', err);
  }
  let stoppedRuns = 0, deniedApprovals = 0, releasedHolds = 0;
  if (state === 'killed') {
    try { stoppedRuns = stopUnfinishedRunsForKill(); }
    catch (err) { console.error('[Emergency] Kill could not stop every workflow run:', err); }
    try {
      const denied = deps.approvalManager.denyAllPending('emergency-kill');
      deniedApprovals = denied.length;
      for (const request of denied) deps.onApprovalDenied?.(request);
    } catch (err) {
      console.error('[Emergency] Kill could not deny every pending approval:', err);
    }
    console.log(`[Emergency] Kill: stopped ${stoppedRuns} workflow run(s), denied ${deniedApprovals} pending approval(s)`);
  } else if (state === 'normal') {
    try { releasedHolds = releaseEmergencyHolds(); }
    catch (err) { console.error('[Emergency] could not release held workflow steps:', err); }
  }
  return { stoppedRuns, deniedApprovals, releasedHolds };
}
