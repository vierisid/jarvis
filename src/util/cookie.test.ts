import { describe, expect, test } from 'bun:test';
import { getCookie } from './cookie.ts';
import { PANEL_SESSION_COOKIE } from '../sidecar/panel-sessions.ts';

/**
 * This parser sits on the authentication path: the WebSocket layer reads the
 * panel session with it on every request, and the permissions routes use it to
 * decide which machine a question is about. Its behaviour was documented but
 * never tested while it lived inside websocket.ts.
 */

function req(cookie?: string): Request {
  return new Request('http://localhost/api/x', {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

describe('getCookie', () => {
  test('reads a value, in any position in the header', () => {
    expect(getCookie(req('panel_session=abc'), PANEL_SESSION_COOKIE)).toBe('abc');
    expect(getCookie(req('theme=dark; panel_session=abc; x=1'), PANEL_SESSION_COOKIE)).toBe('abc');
    expect(getCookie(req('theme=dark;panel_session=abc'), PANEL_SESSION_COOKIE)).toBe('abc');
  });

  test('a missing cookie, or no header at all, is null', () => {
    expect(getCookie(req(), PANEL_SESSION_COOKIE)).toBeNull();
    expect(getCookie(req(''), PANEL_SESSION_COOKIE)).toBeNull();
    expect(getCookie(req('theme=dark'), PANEL_SESSION_COOKIE)).toBeNull();
  });

  test('a malformed escape reads as no cookie rather than throwing', () => {
    // decodeURIComponent throws on this. The value is attacker-controlled and
    // read on the auth path, so an unusable cookie has to mean "unauthenticated"
    // (401), never an unwound 500.
    expect(() => getCookie(req('panel_session=%E0%A4%A'), PANEL_SESSION_COOKIE)).not.toThrow();
    expect(getCookie(req('panel_session=%E0%A4%A'), PANEL_SESSION_COOKIE)).toBeNull();
  });

  test('a name is matched whole, never as the tail of another cookie', () => {
    // "evil_panel_session=x" must not answer for "panel_session". The boundary
    // is what stops an attacker-chosen cookie name shadowing the real one.
    expect(getCookie(req('evil_panel_session=x'), PANEL_SESSION_COOKIE)).toBeNull();
    expect(getCookie(req('evil_panel_session=x; panel_session=real'), PANEL_SESSION_COOKIE)).toBe('real');
  });

  test('the name is escaped before it becomes a pattern', () => {
    // Regex metacharacters in a name would otherwise match something else
    // entirely; "a.c" must not be satisfied by "abc".
    expect(getCookie(req('abc=nope'), 'a.c')).toBeNull();
    expect(getCookie(req('a.c=yes'), 'a.c')).toBe('yes');
  });

  test('percent-encoded values are decoded', () => {
    expect(getCookie(req('panel_session=a%20b'), PANEL_SESSION_COOKIE)).toBe('a b');
  });
});
