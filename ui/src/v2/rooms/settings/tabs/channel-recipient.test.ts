import { describe, expect, test } from 'bun:test';
import { recipientNotice } from './channel-recipient.ts';

/** #890. A connected channel with nowhere to send approval requests says so. */
describe('#890: recipientNotice', () => {
  test('says why there is no recipient, in words the owner can act on', () => {
    expect(recipientNotice('Telegram', { hasRecipient: false, reason: 'empty_list' }))
      .toBe('Telegram is not sent approval requests or notifications: no user ID is saved for it, so there is nobody to send them to.');
    expect(recipientNotice('Discord', { hasRecipient: false, reason: 'no_direct_message' }))
      .toBe('Discord is not sent approval requests or notifications: they go to the last listed user who sent the bot a direct message, and there is none now. Send it one from a listed account (again, if you did before).');
  });

  test('is silent when there is a recipient, and when an older daemon does not say', () => {
    expect(recipientNotice('Telegram', { hasRecipient: true })).toBeNull();
    expect(recipientNotice('Telegram', undefined)).toBeNull();
  });
});
