import { describe, expect, test } from 'bun:test';
import { GMAIL_SEND_SCOPE, GOOGLE_READONLY_SCOPES, googleSendRefusal, googleSendState, grantedGoogleScopes, requestedGoogleScopes, shortGoogleScope } from './google-scopes.ts';

const READ = GOOGLE_READONLY_SCOPES.join(' ');
const SEND = `${READ} ${GMAIL_SEND_SCOPE}`;

describe('Google scopes (#957)', () => {
  test('read-only is what is asked for unless sending was chosen', () => {
    expect(requestedGoogleScopes(false)).toEqual([...GOOGLE_READONLY_SCOPES]);
    expect(requestedGoogleScopes(true)).toEqual([...GOOGLE_READONLY_SCOPES, GMAIL_SEND_SCOPE]);
  });

  test('a grant is read as Google recorded it, and one without a scope is the read-only one', () => {
    expect(grantedGoogleScopes({ scope: SEND })).toContain(GMAIL_SEND_SCOPE);
    expect(grantedGoogleScopes({})).toEqual([...GOOGLE_READONLY_SCOPES]);
    expect(grantedGoogleScopes(null)).toEqual([...GOOGLE_READONLY_SCOPES]);
    expect(grantedGoogleScopes({ scope: SEND }).map(shortGoogleScope)).toEqual(['gmail.readonly', 'calendar.readonly', 'gmail.send']);
  });

  test('self-hosted: the grant decides', () => {
    expect(googleSendState({}, false, { scope: SEND })).toEqual({ canSend: true });
    expect(googleSendState({}, false, { scope: READ })).toEqual({ canSend: false, reason: 'not_granted' });
    expect(googleSendState({}, false, {})).toEqual({ canSend: false, reason: 'not_granted' });
    // The hosted leave means nothing self-hosted: the grant is still read-only.
    expect(googleSendState({ google: { gmail_send: true } }, false, { scope: READ }).canSend).toBe(false);
  });

  test('hosted: a widened grant cannot send unless the system config allows it', () => {
    expect(googleSendState({ google: {} }, true, { scope: SEND })).toEqual({ canSend: false, reason: 'not_enabled_hosted' });
    expect(googleSendState({ google: { gmail_send: true } }, true, { scope: SEND })).toEqual({ canSend: true });
    expect(googleSendState({ google: { gmail_send: true } }, true, { scope: READ })).toEqual({ canSend: false, reason: 'not_granted' });
  });

  test('the refusal says how to allow sending, and that every send still asks', () => {
    expect(googleSendRefusal({ canSend: true })).toBeNull();
    expect(googleSendRefusal({ canSend: false, reason: 'not_granted' })).toMatch(/read-only.*connect again with sending turned on.*asks you first/s);
    expect(googleSendRefusal({ canSend: false, reason: 'not_enabled_hosted' })).toMatch(/not turned on for this instance/);
  });
});
