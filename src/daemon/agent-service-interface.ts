/**
 * Common interface for agent services that can handle messages.
 * Both the main AgentService (user chat) and BackgroundAgentService
 * (reactions) implement this. The 15-min heartbeat was removed in
 * Phase 2, so handleHeartbeat is no longer part of the contract.
 */
export interface IAgentService {
  handleMessage(text: string, channel?: string): Promise<string>;
}
