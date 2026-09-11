/**
 * Common interface for agent services that can handle messages.
 * Both the main AgentService (user chat) and BackgroundAgentService
 * (reactions) implement this. The 15-min heartbeat was removed in
 * Phase 2, so handleHeartbeat is no longer part of the contract.
 */
export interface IAgentService {
  handleMessage(text: string, channel?: string): Promise<string>;
  /**
   * True when the most recent handleMessage turn stopped on at least one
   * approval request instead of finishing the work. Callers that treat a
   * turn's text as "done" (commitment executor, awareness handlers) use
   * this to report "waiting for your approval" instead.
   */
  lastTurnRequestedApproval?(): boolean;
  /** Ids of the approval requests that turn created, for callers that track outcomes. */
  lastTurnApprovalIds?(): string[];
}
