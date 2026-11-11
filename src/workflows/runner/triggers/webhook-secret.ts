/**
 * How a Webhook trigger's signing secret is used (#1153, owner decisions).
 *
 * TIMESTAMPED (`signature_scheme: 'timestamped'`): the sender sends
 * `X-Jarvis-Timestamp` (Unix seconds) and `X-Jarvis-Signature`, the hex
 * HMAC-SHA256 of `<timestamp>.<raw body>`. A request more than
 * `WEBHOOK_TIMESTAMP_TOLERANCE_S` from the daemon's clock is refused, and the
 * same signature is a repeat for as long as its timestamp is accepted, so a
 * captured request cannot be run again later.
 *
 * LEGACY (no scheme, every webhook saved before this): the signature is the
 * HMAC of the raw body alone, and is valid for ever; repeats are recognised
 * only for `SIGNED_REPEAT_WINDOW_MS`. A legacy webhook also accepts a
 * timestamped request, so a sender can move first and the owner switch after.
 *
 * A secret that is created or changed must be at least
 * `WEBHOOK_SECRET_MIN_LENGTH` characters, and it makes the webhook
 * timestamped. A secret already stored keeps working as it is, and a webhook
 * is never moved back from timestamped to legacy while it keeps its secret.
 */

import type { FlowTriggerNode } from '../../db/repos/flow-version';

export type WebhookSignatureScheme = 'timestamped' | 'legacy';

/** The input field that holds the scheme. */
export const SIGNATURE_SCHEME_FIELD = 'signature_scheme';

/** 32 characters: a random secret of that length carries well over 128 bits. */
export const WEBHOOK_SECRET_MIN_LENGTH = 32;

/** How far a timestamped request's clock may be from the daemon's, either way. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_S = 300;

/**
 * How long a timestamped signature counts as a repeat: the whole span over
 * which its timestamp is accepted (a tolerance either side), plus a minute so
 * the record outlives the acceptance even at the edges of a second.
 */
export const TIMESTAMPED_REPEAT_WINDOW_MS = (2 * WEBHOOK_TIMESTAMP_TOLERANCE_S + 60) * 1000;

export class WebhookSecretError extends Error {}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function webhookInput(trigger: unknown): Record<string, unknown> | null {
  if (!object(trigger) || !object(trigger.settings) || trigger.settings.pieceName !== 'webhook') return null;
  return object(trigger.settings.input) ? trigger.settings.input : null;
}

const secretOf = (input: Record<string, unknown> | null): string | null =>
  input && typeof input.secret === 'string' && input.secret !== '' ? input.secret : null;

/**
 * Why a webhook's signing setup cannot be trusted, or null. A secret that is
 * not text (a number, a list), or a "timestamped" scheme with no secret to
 * sign with, was once taken for "no secret" and accepted unsigned requests;
 * a webhook meant to be signed must never fall back to unsigned. `null` and
 * an empty string are "no secret", as the editor writes when it is cleared.
 */
export function webhookSecretProblem(input: unknown): string | null {
  if (!object(input)) return null;
  const secret = input.secret;
  if (secret !== undefined && secret !== null && typeof secret !== 'string') {
    return 'The webhook signing secret must be text. Use a random string of at least 32 characters.';
  }
  if (input[SIGNATURE_SCHEME_FIELD] === 'timestamped' && (typeof secret !== 'string' || secret === '')) {
    return 'This webhook is set to require timestamps but has no signing secret. Add a signing secret, or remove the timestamp setting.';
  }
  return null;
}

/** The same check for a whole trigger node: null unless it is a Webhook trigger with a problem. */
export const triggerSecretProblem = (trigger: unknown): string | null => webhookSecretProblem(webhookInput(trigger));

/** The scheme a webhook trigger's input asks for: legacy unless it says timestamped. */
export function webhookScheme(input: unknown): WebhookSignatureScheme {
  return object(input) && input[SIGNATURE_SCHEME_FIELD] === 'timestamped' ? 'timestamped' : 'legacy';
}

/** What the store holds of a secret: whether a webhook trigger in this project has it, and whether any such one is timestamped. */
export interface KnownSecret { found: boolean; timestamped: boolean }

/**
 * A trigger about to be saved, with the secret rules applied: a created or
 * changed secret is held to the floor and made timestamped; an unchanged one
 * keeps its scheme, which may move to timestamped but never back. "Unchanged"
 * is the previous version's secret, or one a Webhook trigger in the same
 * project already holds (`known`: a draft from an older version after a
 * rollback, a copy the dry runner makes); it is timestamped when any version
 * holding it is. Throws `WebhookSecretError` for a short new secret.
 */
export function applyWebhookSecretRules<T>(previous: unknown, next: T, known: (secret: string) => KnownSecret): T {
  const input = webhookInput(next);
  // A secret that is not text is refused, never read as "no secret".
  if (input && input.secret !== undefined && input.secret !== null && typeof input.secret !== 'string') {
    throw new WebhookSecretError(webhookSecretProblem(input)!);
  }
  const secret = secretOf(input);
  if (!input || secret === null) {
    // A scheme with no secret to sign with, on a webhook that had none: refused. (Clearing a
    // secret leaves the scheme behind for the next line to remove, so that stays allowed.)
    if (input && input[SIGNATURE_SCHEME_FIELD] === 'timestamped' && secretOf(webhookInput(previous)) === null) {
      throw new WebhookSecretError(webhookSecretProblem(input)!);
    }
    // No secret: no scheme to keep.
    if (input && SIGNATURE_SCHEME_FIELD in input) return withInput(next, Object.fromEntries(Object.entries(input).filter(([k]) => k !== SIGNATURE_SCHEME_FIELD)));
    return next;
  }
  const before = webhookInput(previous);
  const same = secretOf(before) === secret;
  const stored = same ? { found: true, timestamped: webhookScheme(before) === 'timestamped' } : known(secret);
  if (!stored.found) {
    if (secret.length < WEBHOOK_SECRET_MIN_LENGTH) {
      throw new WebhookSecretError(`Webhook signing secret must be at least ${WEBHOOK_SECRET_MIN_LENGTH} characters; generate a random one`);
    }
    return input[SIGNATURE_SCHEME_FIELD] === 'timestamped' ? next : withInput(next, { ...input, [SIGNATURE_SCHEME_FIELD]: 'timestamped' });
  }
  // Unchanged: timestamped stays timestamped, and a legacy one may opt in.
  if (stored.timestamped || webhookScheme(input) === 'timestamped') {
    return input[SIGNATURE_SCHEME_FIELD] === 'timestamped' ? next : withInput(next, { ...input, [SIGNATURE_SCHEME_FIELD]: 'timestamped' });
  }
  if (SIGNATURE_SCHEME_FIELD in input) {
    return withInput(next, Object.fromEntries(Object.entries(input).filter(([k]) => k !== SIGNATURE_SCHEME_FIELD)));
  }
  return next;
}

function withInput<T>(trigger: T, input: Record<string, unknown>): T {
  const node = trigger as unknown as FlowTriggerNode;
  return { ...node, settings: { ...node.settings, input } } as unknown as T;
}

/**
 * For a write the assistant makes (#1153 review): a webhook secret it sets,
 * other than the one already saved on this draft, meets the floor whatever
 * else is stored. The save rules let a stored secret keep working below it
 * (a copy, a rollback); offered to the assistant, that exemption would answer
 * whether a short guess is some webhook's secret.
 */
export function assistantWebhookSecretRefusal(saved: unknown, next: unknown): string | null {
  const secret = secretOf(webhookInput(next));
  if (secret === null || secret === secretOf(webhookInput(saved)) || secret.length >= WEBHOOK_SECRET_MIN_LENGTH) return null;
  return `Webhook signing secret must be at least ${WEBHOOK_SECRET_MIN_LENGTH} characters; generate a random one`;
}
