/**
 * #957: which account an email step sends from, and which message a reply or
 * forward answers, for the approval card. Display only: taken once when the
 * effect is recorded and kept beside it (`WorkflowEffect.sender`), outside the
 * request digest, so it never changes what an approval is bound to.
 *
 * The account comes from the step's own connection: Jarvis's Google
 * connection reads its address from the Gmail profile; a saved connection is
 * named as the person named it (an SMTP one with its login and server, which
 * are not secret). Nothing here reads or keeps a credential beyond the one
 * read the Google source makes with its own grant.
 */
import { getFlowVersion } from '../db/repos/flow-version';
import { getConnectionByExternalId } from '../db/repos/app-connection';
import { walkFlowNodes } from '../db/flow-graph';
import type { WorkflowEffect } from '../db/repos/workflow-effect';
import type { JarvisConnectionSource } from '../credentials/adapter';
import { GOVERNED_PIECE_ADAPTERS, SMTP_PIECE } from './piece-effects';

const GMAIL_PIECE = '@activepieces/piece-gmail';
const GMAIL_SENDS: ReadonlySet<string> = new Set(
  GOVERNED_PIECE_ADAPTERS.find(adapter => adapter.pieceName === GMAIL_PIECE)?.categories.send_email ?? []);
const ACCOUNT_MAX = 320;

/** The Google source's display reads (google-source.ts), when the step uses Jarvis's own Google connection. */
interface GoogleDisplaySource extends JarvisConnectionSource {
  accountLabel?(): Promise<string | null>;
  messageSubject?(id: string): Promise<string | null>;
}

/** True for the email sends this describes: every Gmail send and the SMTP send. */
export function describesEmailSender(piece: string, action: string): boolean {
  return (piece === GMAIL_PIECE && GMAIL_SENDS.has(action)) || (piece === SMTP_PIECE && action === 'send-email');
}

/** The connection a step names as its whole `auth`, as the engine reads `{{connections.X}}`. */
export function stepConnectionId(versionId: string, stepName: string): string | null {
  const node = walkFlowNodes(getFlowVersion(versionId)?.trigger).find(n => n.name === stepName);
  const auth = node?.settings?.input?.auth;
  const match = typeof auth === 'string' ? /^\{\{connections(?:\.([\w:-]+)|\['([^']+)'\])\}\}$/u.exec(auth) : null;
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function text(value: unknown, max = ACCOUNT_MAX): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

export async function emailSenderReview(input: {
  projectId: string; versionId: string; stepName: string; piece: string; action: string;
  args: Record<string, unknown>; sources: readonly JarvisConnectionSource[];
}): Promise<WorkflowEffect['sender']> {
  if (!describesEmailSender(input.piece, input.action)) return undefined;
  const externalId = stepConnectionId(input.versionId, input.stepName);
  if (!externalId) return undefined;
  const google = externalId.startsWith('jarvis:')
    ? input.sources.find(source => source.id === 'google' && source.canResolve(externalId)) as GoogleDisplaySource | undefined
    : undefined;
  const out: NonNullable<WorkflowEffect['sender']> = {};
  if (google) {
    out.account = text(await google.accountLabel?.().catch(() => null)) ?? 'Your connected Google account';
  } else if (!externalId.startsWith('jarvis:')) {
    try {
      const connection = getConnectionByExternalId(input.projectId, input.piece, externalId);
      if (connection) {
        const props = connection.value && typeof connection.value === 'object' && connection.value.props
          && typeof connection.value.props === 'object' ? connection.value.props as Record<string, unknown> : {};
        const login = input.piece === SMTP_PIECE ? text(props.email) : undefined;
        const host = input.piece === SMTP_PIECE ? text(props.host, 255) : undefined;
        const name = text(connection.displayName) ?? externalId;
        out.account = login ? `${name} (${login}${host ? ` via ${host}` : ''})` : name;
      }
    } catch { /* No account on the card; the send is judged as before. */ }
  }
  if (input.piece === GMAIL_PIECE) {
    const message = text(input.args.message_id, 128);
    if (message && (input.action === 'reply_to_email' || input.action === 'gmail_reply_to_thread' || input.action === 'gmail_forward_message')) {
      const subject = text(await google?.messageSubject?.(message).catch(() => null), 1000);
      const label = subject ? `"${subject}" (message ${message})` : `message ${message}`;
      if (input.action === 'gmail_forward_message') out.forwards = label; else out.replyTo = label;
    } else if (input.action === 'send_email') {
      // A new message threaded under another by its Message-ID header.
      const header = text(input.args.in_reply_to, 1000);
      if (header) out.replyTo = header;
    }
  }
  return Object.keys(out).length ? out : undefined;
}
