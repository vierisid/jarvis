import { describe, expect, test } from 'bun:test';
import { ownerNotice, recipientNotice } from './channel-recipient.ts';

/** #890. A connected channel with nowhere to send approval requests says so. */
describe('#890: recipientNotice', () => {
  test('says why there is no recipient, in words the owner can act on', () => {
    expect(recipientNotice('Telegram', { hasRecipient: false, reason: 'empty_list' }))
      .toBe('Telegram is not sent approval requests or notifications: no user ID is saved for it, so there is nobody to send them to.');
    expect(recipientNotice('Discord', { hasRecipient: false, reason: 'no_direct_message' }))
      .toBe('Discord is not sent approval requests or notifications until its owner, the first allowed ID, sends the bot a direct message (again, if you did before). Until then they appear on the dashboard only.');
    expect(recipientNotice('Telegram', { hasRecipient: false, reason: 'no_owner' }))
      .toBe("Telegram is not sent approval requests or notifications: the first saved ID is the channel's owner, and it is not a valid ID, so the channel has no owner. Put your own ID first.");
  });

  test('is silent when there is a recipient, and when an older daemon does not say', () => {
    expect(recipientNotice('Telegram', { hasRecipient: true })).toBeNull();
    expect(recipientNotice('Telegram', undefined)).toBeNull();
  });
});

/** #916. The first saved ID owns the channel, and the page says which. */
describe('#916: ownerNotice', () => {
  test('names the first ID as the owner, and says what the others may not do', () => {
    expect(ownerNotice({ allowed_users: [42], owner_id: 42 }))
      .toEqual({ warn: false, text: 'Owner: 42 (the first ID).' });
    expect(ownerNotice({ allowed_users: [42, 7], owner_id: 42 })?.text)
      .toBe('Owner: 42 (the first ID). The other ID may chat, but cannot approve or deny.');
    expect(ownerNotice({ allowed_users: ['1', '2', '3'], owner_id: '1' })?.text)
      .toContain('The other 2 IDs may chat');
  });

  test('warns when the first saved ID is not valid, so nobody owns the channel', () => {
    const n = ownerNotice({ allowed_users: [7], owner_id: null });
    expect(n?.warn).toBe(true);
    expect(n?.text).toStartWith('No owner: the first saved ID is not a valid ID.');
  });

  test('is silent with nothing saved, and when an older daemon does not say', () => {
    expect(ownerNotice({ allowed_users: [], owner_id: null })).toBeNull();
    expect(ownerNotice({ allowed_users: [42] })).toBeNull();
    expect(ownerNotice(undefined)).toBeNull();
  });
});
