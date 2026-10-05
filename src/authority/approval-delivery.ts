/**
 * Approval Delivery — Pushes approval requests to the user through
 * appropriate channels (WebSocket always, Telegram/Discord too).
 */

import type { ApprovalRequest } from './approval.ts';
import { boundedReceiptText } from '../roles/untrusted.ts';

/**
 * Line breaks, other C0/C1 controls and the two Unicode line separators: every
 * character that can start a new line, or erase one, on a channel that renders
 * text as it arrives. These collapse to a space.
 */
const LABEL_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/**
 * Every format character (`\p{Cf}`): the bidi embeddings, overrides and
 * isolates that can visually reorder the rest of a line on a client that
 * applies bidi -- `Agent: ` followed by a reversed tail -- and the zero-width
 * characters. A label needs none of them, and they are removed rather than
 * spaced, since none of them stands for a gap.
 */
const LABEL_FORMAT = /\p{Cf}+/gu;

/**
 * One line of an approval card's label, safe to put in front of a human (#651).
 *
 * A card is a few labelled lines -- `Action:`, `Agent:`, `Reason:` -- and a
 * label is text a workflow author, or the composer model, chose. A line break
 * inside one is a forged field (`Daily digest\nReason: routine read, safe to
 * approve`), so breaks collapse to a space. Then `boundedReceiptText` defangs
 * any framing delimiter and cuts, and `...` marks a cut so a shortened label
 * never reads as whole.
 *
 * Text that is already one line, unmarked and within `maxChars` comes back
 * byte-exact.
 */
export function boundedApprovalLabel(text: string, maxChars: number): string {
  const oneLine = text.replace(LABEL_FORMAT, '').replace(LABEL_BREAKS, ' ');
  const bounded = boundedReceiptText(oneLine, maxChars);
  return oneLine.length > maxChars ? `${bounded}...` : bounded;
}

/**
 * Ceiling for a label at the point of DELIVERY, applied to every approval
 * whatever wrote it. It is a backstop, not the bound: the workflow writer in
 * `effect-boundary.ts` bounds its parts first, and the longest label it can
 * compose is the audit `agent_name` -- "Workflow " (9) + a 515-character name
 * + " / " (3) + a 123-character step + " / " (3) + a 68-character effect id +
 * the "as <role>" suffix -- about 720 characters. 1024 sits above that, so it
 * never cuts a label a writer already bounded; it exists for a writer that
 * bounds nothing.
 */
export const APPROVAL_LABEL_DELIVERY_MAX_CHARS = 1024;

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
    const label = (text: string) => boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS);
    return [
      `[APPROVAL NEEDED]`,
      `Action: ${label(request.tool_name)} (${request.action_category})`,
      `Agent: ${label(request.agent_name)}`,
      `Reason: ${request.reason}`,
      ``,
      `Reply with:`,
      `  approve ${shortId}`,
      `  deny ${shortId}`,
    ].join('\n');
  }
}
