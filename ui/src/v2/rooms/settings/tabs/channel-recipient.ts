import type { ChannelRecipientStatus } from "../useSettingsData";

/**
 * The Channels tab's warning for a connected channel that has nowhere to send
 * approval requests and notifications (#890). They go only to the private chat
 * of the channel's owner, the first allowed ID (#916), learned from a direct
 * message the owner sent the bot: a bot cannot start a chat with someone who
 * never messaged it. Null when there is a recipient, or the daemon did not say.
 */
export function recipientNotice(label: string, status: ChannelRecipientStatus | undefined): string | null {
  if (!status || status.hasRecipient) return null;
  if (status.reason === "empty_list") {
    return `${label} is not sent approval requests or notifications: no user ID is saved for it, so there is nobody to send them to.`;
  }
  if (status.reason === "no_owner") {
    return `${label} is not sent approval requests or notifications: the first saved ID is the channel's owner, and it is not a valid ID, so the channel has no owner. Put your own ID first.`;
  }
  return `${label} is not sent approval requests or notifications until its owner, the first allowed ID, sends the bot a direct message (again, if you did before). Until then they appear on the dashboard only.`;
}

/**
 * Who owns the channel (#916), shown under the allowed IDs: the first saved
 * ID, when it is a valid one. Only the owner gets approval cards and may
 * approve or deny from the channel. Null when nothing is saved, or the daemon
 * did not say.
 */
export function ownerNotice(
  list: { allowed_users: Array<number | string>; owner_id?: number | string | null } | undefined,
): { text: string; warn: boolean } | null {
  if (!list || list.owner_id === undefined) return null;
  if (list.owner_id === null) {
    if (list.allowed_users.length === 0) return null;
    return {
      warn: true,
      text: "No owner: the first saved ID is not a valid ID. Until your own ID is first, nobody gets approval cards here, and nobody may approve or deny from this channel.",
    };
  }
  const others = list.allowed_users.length - 1;
  return {
    warn: false,
    text: `Owner: ${String(list.owner_id)} (the first ID).${others > 0 ? ` The ${others === 1 ? "other ID" : `other ${others} IDs`} may chat, but cannot approve or deny.` : ""}`,
  };
}
