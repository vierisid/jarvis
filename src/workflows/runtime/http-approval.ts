/**
 * What an HTTP or GraphQL step says to the person who must approve it, and the
 * requests refused before anyone is asked.
 *
 * Daemon only (the engine bundle never imports this). The words name the
 * method and the host, never the path or query, which can carry a credential
 * or a customer's data.
 */

import { isIP } from 'node:net';
import { destinationAllowed, type EgressPolicy } from './http-egress';
import { GRAPHQL_PIECE, HTTP_PIECE, httpRequestHost, httpRequestIsRead } from './piece-effects';

/** True for the action of the HTTP and GraphQL pieces that makes a request. */
export function makesNetworkRequest(piece: string, action: string): boolean {
  return action === 'send_request' && (piece === HTTP_PIECE || piece === GRAPHQL_PIECE);
}

/** The card sentence: what the request will do, in words. */
export function httpApprovalIntent(piece: string, input: Record<string, unknown>): string {
  const host = httpRequestHost(input.url);
  if (piece === GRAPHQL_PIECE) return `Jarvis wants to send a GraphQL request to ${host ?? 'a web address set when the step runs'}`;
  if (httpRequestIsRead(input)) return `Jarvis wants to read ${host ?? 'a web address set when the step runs'}`;
  const method = typeof input.method === 'string' && /^[A-Za-z]{1,16}$/u.test(input.method) ? `${input.method.toUpperCase()} ` : '';
  return `Jarvis wants to send a ${method}request to ${host ?? 'a web address set when the step runs'}`;
}

/**
 * Why the request asks, as the card says it (the engine's own wording names a
 * category, not the request). `unlistedRead` is true when an HTTP read asks
 * only because its host is not on the flow's read list. A read whose host is
 * listed and still asks (reads governed by the owner's settings) gets no
 * sentence here: the engine's own reason is the true one.
 */
export function httpApprovalReason(piece: string, input: Record<string, unknown>, unlistedRead: boolean): string | undefined {
  if (unlistedRead) return 'This site is not on the workflow\'s list of sites it may read without asking.';
  if (piece === HTTP_PIECE && httpRequestIsRead(input)) return undefined;
  return 'Sending a request to another server needs your approval.';
}

export const LOCAL_ADDRESS_REFUSAL = 'Jarvis does not send requests to addresses on this computer or local network.';

/**
 * The refusal for a request the egress guard would refuse as soon as it ran: a
 * URL whose host is `localhost` or an address outside the policy (loopback,
 * link-local, this machine's own, and private ranges on a hosted install).
 * Asked before a card is raised, so nobody approves what cannot run. A name
 * that resolves to such an address is still refused by the guard at connect
 * time, after the lookup this check cannot make.
 */
export function localAddressRefusal(input: Record<string, unknown>, policy: EgressPolicy): string | null {
  return localHostRefusal(httpRequestHost(input.url), policy);
}

/** As `localAddressRefusal`, for a host in `readHostKey` form (a read-list entry). */
export function localHostRefusal(host: string | null, policy: EgressPolicy): string | null {
  if (host === null) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return LOCAL_ADDRESS_REFUSAL;
  return isIP(host) !== 0 && !destinationAllowed(host, policy) ? LOCAL_ADDRESS_REFUSAL : null;
}
