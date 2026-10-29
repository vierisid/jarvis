/** Q-07: read back exact receipts only. A missing message is never proof of no send. */
import { getConnection, getConnectionByExternalId } from '../db/repos/app-connection';
import { getFlowVersion } from '../db/repos/flow-version';
import type { WorkflowEffect } from '../db/repos/workflow-effect';
import { walkFlowNodes } from '../db/flow-graph';
import { digest } from './effect-context';
import { isGmailTrackedSend, tracksPieceCompletion } from './piece-effects';

export type ProviderEvidence = { outcome: 'confirmed' | 'inconclusive' | 'unsupported' | 'blocked'; reason: string; reference?: string };

/** Bind a native OAuth connection to the credential the engine actually resolved.
 * Managed/dynamic credentials deliberately have no lookup adapter yet. */
export function captureProviderBinding(input: {
  projectId: string; versionId: string; stepName: string; piece: string; credentialDigest?: string;
}): WorkflowEffect['providerBinding'] {
  if (!input.credentialDigest) return undefined;
  const version = getFlowVersion(input.versionId);
  const node = walkFlowNodes(version?.trigger).find(n => n.name === input.stepName);
  const supportedVersion = input.piece === '@activepieces/piece-gmail' ? '0.17.0'
    : input.piece === '@activepieces/piece-slack' ? '0.21.0' : null;
  if (!supportedVersion || node?.settings?.pieceVersion !== supportedVersion) return undefined;
  const auth = node?.settings?.input?.auth;
  const match = typeof auth === 'string' && /^\{\{connections(?:\.([\w:-]+)|\['([^']+)'\])\}\}$/.exec(auth);
  const externalId = match && (match[1] ?? match[2]);
  if (!externalId || externalId.startsWith('jarvis:')) return undefined;
  try {
    const connection = getConnectionByExternalId(input.projectId, input.piece, externalId);
    const token = connection?.value.access_token;
    if (!connection || connection.type !== 'OAUTH2' || connection.status !== 'ACTIVE' || typeof token !== 'string'
      || digest(token) !== input.credentialDigest) return undefined;
    return { connectionId: connection.id, credentialDigest: input.credentialDigest };
  } catch { return undefined; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Typed completion evidence is broader than the modes supported by readback. */
export function pieceCompletionReceipt(effect: WorkflowEffect): { provider: 'gmail' | 'slack'; id: string; channel?: string } | null {
  if (effect.route !== 'piece-dispatch' || !tracksPieceCompletion(effect.provenance.piece, effect.provenance.action, effect.arguments)) return null;
  const raw = object(effect.result);
  const result = effect.provenance.piece === '@activepieces/piece-gmail' ? object(raw?.data) ?? raw : raw;
  if (!result) return null;
  if (effect.provenance.piece === '@activepieces/piece-gmail') {
    if (effect.arguments.draft === true || typeof result.id !== 'string' || !/^[a-f0-9]{1,128}$/i.test(result.id)) return null;
    return { provider: 'gmail', id: result.id };
  }
  // Only Gmail and Slack have completion evidence; other tracked writes (including HTTP and Sheets) have none.
  if (effect.provenance.piece !== '@activepieces/piece-slack') return null;
  if (result.ok !== true || typeof result.ts !== 'string' || !/^\d{1,20}\.\d{1,10}$/.test(result.ts)
    || typeof result.channel !== 'string' || !/^[A-Z0-9]{1,80}$/.test(result.channel)) return null;
  return { provider: 'slack', id: result.ts, channel: result.channel };
}

export function providerReceipt(effect: WorkflowEffect): ReturnType<typeof pieceCompletionReceipt> {
  const receipt = pieceCompletionReceipt(effect);
  // A Gmail label change completes with the labeled message, usually an incoming
  // one: proof the change finished, but no send receipt, so the SENT readback
  // cannot confirm it. It has no lookup.
  if (receipt?.provider === 'gmail' && !isGmailTrackedSend(effect.provenance.action)) return null;
  if (receipt?.provider === 'slack' && (effect.arguments.file || effect.arguments.threadTs || effect.arguments.sendAsUser === true
    || effect.provenance.action === 'send_channel_message' && effect.arguments.sendAsBot !== true)) return null;
  return receipt;
}

/** Only fixed provider hosts and GETs. Never accept a URL or credential from a recovery choice. */
export async function lookupProviderReceipt(effect: WorkflowEffect, checkpoint: () => void, fetchImpl: typeof fetch = fetch): Promise<ProviderEvidence> {
  const receipt = providerReceipt(effect);
  if (!receipt || !effect.providerBinding) return { outcome: 'unsupported', reason: 'No supported, durably bound provider receipt. Inspect the provider before a new intentional run.' };
  try {
    const connection = getConnection(effect.providerBinding.connectionId);
    const token = connection?.value.access_token;
    if (!connection || connection.projectId !== effect.projectId || connection.pieceName !== effect.provenance.piece
      || connection.type !== 'OAUTH2' || connection.status !== 'ACTIVE' || typeof token !== 'string' || digest(token) !== effect.providerBinding.credentialDigest) {
      return { outcome: 'blocked', reason: 'The dispatch connection is unavailable or changed. Inspect the original account.' };
    }
    checkpoint();
    const url = receipt.provider === 'gmail'
      ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${receipt.id}?format=minimal`
      : `https://slack.com/api/conversations.history?${new URLSearchParams({ channel: receipt.channel!, latest: receipt.id, oldest: receipt.id, inclusive: 'true', limit: '1' })}`;
    const response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    // Bound untrusted provider data, including a streaming response without Content-Length.
    if (!response.ok) { await response.body?.cancel(); return { outcome: 'inconclusive', reason: `Provider lookup returned HTTP ${response.status}; this does not establish that nothing happened.` }; }
    const reader = response.body?.getReader();
    if (!reader) return { outcome: 'inconclusive', reason: 'Provider returned no receipt.' };
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65_536) { await reader.cancel(); return { outcome: 'inconclusive', reason: 'Provider receipt exceeded the lookup limit.' }; }
      chunks.push(part.value);
    }
    checkpoint();
    const data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const confirmed = receipt.provider === 'gmail'
      ? data?.id === receipt.id && Array.isArray(data.labelIds) && data.labelIds.includes('SENT')
      : data?.ok === true && Array.isArray(data.messages) && data.messages.some(m => object(m)?.ts === receipt.id && object(m)?.type === 'message');
    return confirmed
      ? { outcome: 'confirmed', reason: 'The provider returned the exact persisted send receipt. Delivery to or reading by the recipient is not established.', reference: receipt.provider === 'gmail' ? `gmail:${receipt.id}` : `slack:${receipt.channel}:${receipt.id}` }
      : { outcome: 'inconclusive', reason: 'The exact sent message was not confirmed. Absence, deletion, or missing access cannot establish no send.' };
  } catch {
    return { outcome: 'inconclusive', reason: 'Provider lookup did not complete. Inspect the original account; do not replay this action.' };
  }
}
