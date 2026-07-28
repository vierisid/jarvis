/**
 * Approval Delivery — Pushes approval requests to the user through
 * appropriate channels (WebSocket always, Telegram/Discord too).
 */

import type { ApprovalRequest } from './approval.ts';

export type ApprovalBroadcaster = {
  broadcastApprovalRequest(request: ApprovalRequest): void;
};

export type ChannelSender = {
  broadcastToAll(text: string): Promise<void>;
};

export class ApprovalDelivery {
  private broadcaster: ApprovalBroadcaster | null = null;
  private channelSender: ChannelSender | null = null;

  setBroadcaster(broadcaster: ApprovalBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  setChannelSender(sender: ChannelSender): void {
    this.channelSender = sender;
  }

  /**
   * Deliver an approval request to all appropriate channels.
   */
  async deliver(request: ApprovalRequest): Promise<void> {
    // Always push to dashboard via WebSocket
    this.broadcaster?.broadcastApprovalRequest(request);

    // Always push to Telegram/Discord so users can approve/deny directly
    // from messaging channels without opening the dashboard.
    if (this.channelSender) {
      const message = this.formatApprovalMessage(request);
      try {
        await this.channelSender.broadcastToAll(message);
      } catch (err) {
        console.error('[ApprovalDelivery] Failed to send to external channels:', err);
      }
    }
  }

  private formatApprovalMessage(request: ApprovalRequest): string {
    const shortId = request.id.slice(0, 8);
    return [
      `[APPROVAL NEEDED]`,
      `Action: ${request.tool_name} (${request.action_category})`,
      `Agent: ${request.agent_name}`,
      `Reason: ${request.reason}`,
      ``,
      `Reply with:`,
      `  approve ${shortId}`,
      `  deny ${shortId}`,
    ].join('\n');
  }
}
