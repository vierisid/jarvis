import type { ChannelRecipientStatus } from "../useSettingsData";

/**
 * The Channels tab's warning for a connected channel that has nowhere to send
 * approval requests and notifications (#890). Since #852 they go only to the
 * private chat of a listed user, so after a revocation, or before any listed
 * user has messaged the bot, they were skipped with nothing on screen to say
 * so. Null when there is a recipient, or the daemon did not say.
 */
export function recipientNotice(label: string, status: ChannelRecipientStatus | undefined): string | null {
  if (!status || status.hasRecipient) return null;
  if (status.reason === "empty_list") {
    return `${label} is not sent approval requests or notifications: no user ID is saved for it, so there is nobody to send them to.`;
  }
  return `${label} is not sent approval requests or notifications: they go to the last listed user who sent the bot a direct message, and there is none now. Send it one from a listed account (again, if you did before).`;
}
