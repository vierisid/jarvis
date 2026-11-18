/**
 * What Jarvis's own Google connection may do (#957).
 *
 * Read-only is the default: Gmail and Calendar read scopes, nothing else. The
 * owner may add Gmail sending as an explicit choice: self-hosted, by
 * connecting again from Settings with sending turned on, so Google asks for
 * the `gmail.send` scope; hosted, only when the system config written by the
 * control plane says so (`google.gmail_send: true`) and the delivered grant
 * carries the scope. Every send still waits for the owner's approval card.
 *
 * The scopes are read from the grant itself (`scope` in the tokens file, as
 * Google returned it), never assumed. A grant saved before the field existed
 * has none and reads as read-only, which is what it was asked for.
 */
import type { GoogleTokens } from './google-auth.ts';
import type { JarvisConfig } from '../config/types.ts';

export const GOOGLE_SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
export const GMAIL_READONLY_SCOPE = `${GOOGLE_SCOPE_PREFIX}gmail.readonly`;
export const CALENDAR_READONLY_SCOPE = `${GOOGLE_SCOPE_PREFIX}calendar.readonly`;
export const GMAIL_SEND_SCOPE = `${GOOGLE_SCOPE_PREFIX}gmail.send`;
export const GOOGLE_READONLY_SCOPES: readonly string[] = [GMAIL_READONLY_SCOPE, CALENDAR_READONLY_SCOPE];

/** The scopes to ask Google for: read-only, plus sending only when the owner chose it. */
export function requestedGoogleScopes(send: boolean): string[] {
  return send ? [...GOOGLE_READONLY_SCOPES, GMAIL_SEND_SCOPE] : [...GOOGLE_READONLY_SCOPES];
}

/** The scopes this grant holds, full URLs. A grant without a recorded scope is the read-only one. */
export function grantedGoogleScopes(tokens: Pick<GoogleTokens, 'scope'> | null | undefined): string[] {
  const scope = tokens?.scope;
  if (typeof scope !== 'string' || !scope.trim()) return [...GOOGLE_READONLY_SCOPES];
  return [...new Set(scope.split(/\s+/u).filter(Boolean))];
}

/** "gmail.readonly" for the status route and the settings tab. */
export function shortGoogleScope(scope: string): string {
  return scope.startsWith(GOOGLE_SCOPE_PREFIX) ? scope.slice(GOOGLE_SCOPE_PREFIX.length) : scope;
}

export type GoogleSendState =
  /** The grant holds gmail.send and this instance allows sending with it. */
  | { canSend: true }
  | { canSend: false; reason: 'not_granted' | 'not_enabled_hosted' };

/**
 * Whether Jarvis's own Google connection may send mail. `managed` is the
 * hosted shape (`classifyGoogle(...).mode === 'managed'`): there the system
 * config must grant sending as well, so a grant the control plane widened
 * without the instance's config saying so still cannot send.
 */
export function googleSendState(
  config: { google?: JarvisConfig['google'] },
  managed: boolean,
  tokens: Pick<GoogleTokens, 'scope'> | null | undefined,
): GoogleSendState {
  if (managed && config.google?.gmail_send !== true) return { canSend: false, reason: 'not_enabled_hosted' };
  return grantedGoogleScopes(tokens).includes(GMAIL_SEND_SCOPE) ? { canSend: true } : { canSend: false, reason: 'not_granted' };
}

/** Why a Gmail send with Jarvis's own Google connection cannot run, for the step and readiness. */
export function googleSendRefusal(state: GoogleSendState): string | null {
  if (state.canSend) return null;
  return state.reason === 'not_enabled_hosted'
    ? 'Your Google account is connected read-only on this hosted instance, so Jarvis cannot send mail from it. Sending is not turned on for this instance.'
    : 'Your Google account is connected read-only, so Jarvis cannot send mail from it. To allow sending, open Settings > Integrations > Google and connect again with sending turned on. Every send still asks you first.';
}
