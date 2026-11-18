/**
 * #957: the same email is not sent twice across runs without asking.
 *
 * Within a run, a retried step is already covered: a tracked send's dispatch
 * fence and receipt (Q-07). Across runs nothing was: a re-triggered flow, a
 * second webhook delivery or a run started again by hand sent the same
 * message again. Every email send a workflow records is noted here by a key
 * over what it sends: the account (the step's connection), the recipients
 * (to, cc and bcc, or the message a reply or forward answers), the subject
 * and the body. A later send with the same key within 24 hours, from another
 * run, raises a "send again?" card naming the earlier run, even where the
 * send would otherwise go without asking. It is never refused: the owner may
 * mean to send it again.
 *
 * The key is taken over the effect's bounded projection, the one its card
 * shows: a body past 512 characters is the first 512 and its length. Two
 * bodies that agree on both can match; that costs a card, never a send.
 *
 * What counts as the earlier send: one sent, one that may have been sent
 * (dispatching, unknown), and one still waiting for its approval, so a second
 * card for the same email says the first is waiting. A send refused or
 * blocked before it went out does not count. A note whose run was deleted
 * still counts: the email may have gone out.
 */
import { getWorkflowDb } from '../db';
import { digest } from './effect-context';
import type { WorkflowEffect } from '../db/repos/workflow-effect';

export const EMAIL_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

const RECIPIENT_KEYS = ['to', 'receiver', 'cc', 'bcc'] as const;
/** What a reply, forward or draft send is addressed by when it names no recipient itself. */
const ANSWER_KEYS = ['message_id', 'thread_id', 'draft_id'] as const;
const BODY_KEYS = ['body', 'text', 'html', 'note'] as const;

function addresses(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/u) : [];
  return items.filter((item): item is string => typeof item === 'string').map(item => item.trim().toLowerCase()).filter(Boolean);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : JSON.stringify(value);
}

/**
 * The key of an email send: account, recipients, subject and body. Null when
 * the input names none of them (no recipient, no message it answers, no
 * subject, no body): such a send cannot be told apart from any other from the
 * same account, so it is not checked rather than matched with all of them.
 */
export function emailSendKey(projectId: string, account: string, args: Record<string, unknown>): string | null {
  const recipients = [...new Set(RECIPIENT_KEYS.flatMap(key => addresses(args[key])))].sort();
  const answers = ANSWER_KEYS.map(key => [key, textOf(args[key])] as const).filter(([, value]) => value);
  const body = BODY_KEYS.map(key => [key, textOf(args[key])] as const).filter(([, value]) => value);
  const subject = textOf(args.subject);
  if (!recipients.length && !answers.length && !body.length && !subject) return null;
  return digest(['email-send-v1', projectId, account, recipients, answers, subject, body]);
}

export type EarlierSend = NonNullable<WorkflowEffect['duplicateOf']>;

/**
 * The most recent other-run send with this key in the last 24 hours that went
 * out, may have, or waits for approval; null when there is none.
 */
export function findEarlierSend(projectId: string, sendKey: string, runId: string, now = Date.now()): EarlierSend | null {
  const rows = getWorkflowDb().query<{ effect_id: string; run_id: string; workflow_name: string; created_at: number; status: string | null; decision: string | null }, [string, string, number, string]>(
    `SELECT s.effect_id, s.run_id, s.workflow_name, s.created_at, e.status,
        CASE WHEN json_valid(e.record) THEN json_extract(e.record, '$.decision') END AS decision
      FROM workflow_email_send s LEFT JOIN workflow_effect e ON e.id = s.effect_id
      WHERE s.project_id = ? AND s.send_key = ? AND s.created_at >= ? AND s.run_id <> ?
      ORDER BY s.created_at DESC LIMIT 50`,
  ).all(projectId, sendKey, now - EMAIL_DEDUP_WINDOW_MS, runId);
  for (const row of rows) {
    const state: EarlierSend['state'] | null = row.status === null ? 'may_have_sent'
      : row.status === 'succeeded' ? 'sent'
      : row.status === 'dispatching' || row.status === 'unknown' ? 'may_have_sent'
      : row.status === 'pending' && row.decision !== 'denied' ? 'waiting'
      : null;
    if (state) return { runId: row.run_id, effectId: row.effect_id, workflowName: row.workflow_name, at: row.created_at, state };
  }
  return null;
}

/** Note a recorded send, and forget notes past the window. */
export function noteEmailSend(input: { effectId: string; sendKey: string; projectId: string; runId: string; workflowName: string; at?: number }): void {
  const at = input.at ?? Date.now();
  const db = getWorkflowDb();
  db.run('DELETE FROM workflow_email_send WHERE created_at < ?', [at - EMAIL_DEDUP_WINDOW_MS]);
  db.run(`INSERT OR IGNORE INTO workflow_email_send (effect_id, send_key, project_id, run_id, workflow_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [input.effectId, input.sendKey, input.projectId, input.runId, input.workflowName, at]);
}

/** The "send again?" sentence for the card, in the owner's words. */
export function sendAgainReason(earlier: EarlierSend): string {
  const when = new Date(earlier.at).toISOString().slice(0, 16).replace('T', ' ');
  const where = `run ${earlier.runId} of "${earlier.workflowName}"`;
  const what = earlier.state === 'sent' ? `was sent at ${when} UTC by ${where}`
    : earlier.state === 'may_have_sent' ? `may already have been sent at ${when} UTC by ${where}`
    : `is already waiting for your approval in ${where} (asked at ${when} UTC)`;
  return `Send again? The same email (same account, recipients, subject and body) ${what}. Approve only if you mean to send it again.`;
}
