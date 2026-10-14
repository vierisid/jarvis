import { randomUUID } from 'node:crypto';
import { GOOGLE_ONBOARDING_SCOPES, type GoogleBinding, type GoogleConnection, type GooglePorts,
  type GoogleScope, type GoogleSnapshot, type GoogleStart } from './types.ts';

const TTL = 10 * 60_000;
const MAX_OWNERS = 256;
const sameOwner = (a: GoogleScope, b: GoogleScope) => a.actorId === b.actorId && a.projectId === b.projectId;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
interface Attempt { id: string; state?: string; expiresAt: number; consumed: boolean; cancelled: boolean }
interface Slot {
  bindingId: string;
  attempt?: Attempt;
  connection: GoogleConnection;
  reason: string;
  revision: number;
  touched: number;
  tail: Promise<void>;
  queued: number;
}
export class GoogleStateError extends Error {
  constructor(public readonly code: 'unauthorized' | 'unavailable' | 'invalid_request' | 'invalid_callback') {
    super(`Google connection: ${code}`);
  }
}

/** Optional server provider. No routes, timers, OAuth calls or storage writes at construction. */
export function createGoogleProvider<Context>(ports: GooglePorts<Context>) {
  const slots = new Map<string, Slot>();
  const now = ports.now ?? Date.now;
  async function selected(context: Context) {
    const scope = await ports.authorize(context);
    if (!scope || !validId(scope.actorId) || !validId(scope.projectId)) throw new GoogleStateError('unauthorized');
    const resolved = await ports.resolve(scope);
    if (!resolved || !validId(resolved.id) || !sameOwner(scope, resolved.owner)
      || !['self', 'hosted'].includes(resolved.installMode)) throw new GoogleStateError('unavailable');
    const binding = { ...resolved, owner: { ...resolved.owner }, self: resolved.self ? { ...resolved.self } : undefined };
    const key = JSON.stringify([scope.actorId, scope.projectId]);
    let slot = slots.get(key);
    if (!slot) {
      for (const [key, value] of slots) if (!value.queued && now() - value.touched > TTL * 2) slots.delete(key);
      if (slots.size >= MAX_OWNERS) throw new GoogleStateError('unavailable');
      slot = { bindingId: binding.id, connection: { state: 'idle' }, reason: 'not_connected', revision: 0,
        touched: now(), tail: Promise.resolve(), queued: 0 };
      slots.set(key, slot);
    }
    slot.touched = now();
    return { binding, slot };
  }
  function set(slot: Slot, connection: GoogleConnection, reason: string) {
    slot.connection = connection; slot.reason = reason; slot.revision++;
  }
  function snapshot(binding: GoogleBinding, slot: Slot): GoogleSnapshot {
    return { schemaVersion: 1, provider: 'google', installMode: binding.installMode, supported: true,
      ready: slot.connection.state === 'connected', revision: slot.revision, reason: slot.reason,
      connection: structuredClone(slot.connection) };
  }
  function expire(slot: Slot) {
    const attempt = slot.attempt;
    if (attempt && !attempt.cancelled && attempt.expiresAt <= now() && slot.connection.state === 'pending') {
      set(slot, { state: 'expired', attemptId: attempt.id }, 'attempt_expired');
    }
  }
  async function serial<T>(context: Context, action: (binding: GoogleBinding, slot: Slot) => Promise<T>): Promise<T> {
    const { binding, slot } = await selected(context);
    slot.queued++;
    const assertCurrent = async () => {
      const current = await ports.resolve(binding.owner);
      if (!current || current.id !== binding.id || current.installMode !== binding.installMode
        || !sameOwner(current.owner, binding.owner)) throw new GoogleStateError('unavailable');
    };
    const work = slot.tail.then(async () => {
      await assertCurrent();
      if (slot.bindingId !== binding.id) {
        slot.bindingId = binding.id; slot.attempt = undefined;
        set(slot, { state: 'idle' }, 'binding_changed');
      }
      expire(slot);
      const result = await action(binding, slot);
      await assertCurrent();
      return result;
    });
    slot.tail = work.then(() => {}, () => {});
    try { return await work; } finally { slot.queued--; slot.touched = now(); }
  }
  async function refresh(binding: GoogleBinding, slot: Slot, completedAttempt?: string) {
    const revision = slot.revision;
    let grant;
    try { grant = await binding.readGrant(); } catch { grant = { state: 'unverified' as const }; }
    // Cancel may run while the read awaits. Do not undo it with an old response.
    if (revision !== slot.revision) return snapshot(binding, slot);
    expire(slot);
    if (grant.state === 'verified' && validId(grant.accountLabel) && Array.isArray(grant.scopes)
      && grant.scopes.length <= 128 && grant.scopes.every(s => typeof s === 'string' && s.length <= 512)
      && GOOGLE_ONBOARDING_SCOPES.every(scope => grant.scopes.includes(scope))) {
      const attempt = slot.attempt;
      const correlated = completedAttempt && attempt?.id === completedAttempt && !attempt.cancelled
        && attempt.expiresAt > now() ? completedAttempt : null;
      set(slot, { state: 'connected', attemptId: correlated, accountLabel: grant.accountLabel,
        grantedAccessSummary: 'Verified Gmail read access and Calendar read access.', scopes: [...grant.scopes] }, 'verified');
    } else if (grant.state === 'revoked' || grant.state === 'unverified' || grant.state === 'verified') {
      set(slot, { state: 'error', attemptId: slot.attempt?.id ?? null,
        message: grant.state === 'revoked' ? 'Google access was revoked. Connect again, or skip for now.'
          : 'Google access could not be verified. Try again, or skip for now.' }, grant.state === 'revoked' ? 'grant_revoked' : 'grant_unverified');
    } else if (slot.connection.state === 'connected') {
      set(slot, { state: 'idle' }, 'not_connected');
    }
    return snapshot(binding, slot);
  }
  return {
    read(context: Context) { return serial(context, (binding, slot) => refresh(binding, slot)); },
    begin(context: Context): Promise<GoogleStart> {
      return serial(context, async (binding, slot) => {
        const previousAttempt = slot.attempt, wasCancelled = previousAttempt?.cancelled;
        const read = await refresh(binding, slot);
        if (read.ready || slot.connection.state === 'pending' || previousAttempt && !wasCancelled && previousAttempt.cancelled) return { snapshot: read };
        const attempt: Attempt = { id: randomUUID(), expiresAt: now() + TTL, consumed: false, cancelled: false };
        slot.attempt = attempt;
        try {
          let url: string;
          if (binding.installMode === 'hosted') {
            const parsed = new URL(binding.hostedConnectUrl ?? '');
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid URL');
            url = parsed.href;
          } else {
            if (!binding.self) throw new Error('missing OAuth service');
            const flow = binding.self.flows.start(binding.self.redirectUri, now());
            attempt.state = flow.state; attempt.expiresAt = Math.min(attempt.expiresAt, flow.expiresAt);
            url = binding.self.auth.getAuthUrl([...GOOGLE_ONBOARDING_SCOPES], { state: flow.state, codeChallenge: flow.codeChallenge });
          }
          set(slot, { state: 'pending', attemptId: attempt.id }, 'awaiting_google');
          return { snapshot: snapshot(binding, slot), launch: { attemptId: attempt.id, url } };
        } catch {
          set(slot, { state: 'unavailable', message: 'Google connection is unavailable. You can skip for now.' }, 'oauth_unavailable');
          return { snapshot: snapshot(binding, slot) };
        }
      });
    },
    /** Cancel stops waiting, not a grant already being saved by GoogleAuth. Skip uses this same path. */
    async cancel(context: Context, attemptId: string) {
      if (!validId(attemptId)) throw new GoogleStateError('invalid_request');
      const { binding, slot } = await selected(context);
      if (slot.bindingId !== binding.id) throw new GoogleStateError('unavailable');
      if (slot.bindingId === binding.id && slot.attempt?.id === attemptId && slot.connection.state !== 'connected') {
        slot.attempt.cancelled = true;
        set(slot, { state: 'cancelled', attemptId }, 'waiting_cancelled');
      }
      return snapshot(binding, slot);
    },
    async externalFailed(context: Context, attemptId: string) {
      if (!validId(attemptId)) throw new GoogleStateError('invalid_request');
      const { binding, slot } = await selected(context);
      if (slot.bindingId !== binding.id) throw new GoogleStateError('unavailable');
      if (slot.bindingId === binding.id && slot.attempt?.id === attemptId && slot.connection.state === 'pending') {
        slot.attempt.cancelled = true;
        set(slot, { state: 'error', attemptId, message: 'The sign-in window could not open. Try again, or skip for now.' }, 'external_open_failed');
      }
      return snapshot(binding, slot);
    },
    callback(context: Context, input: { state: string; code?: string; error?: string }) {
      return serial(context, async (binding, slot) => {
        const attempt = slot.attempt;
        if (binding.installMode !== 'self' || !binding.self || !attempt || !validId(input.state)
          || attempt.state !== input.state || attempt.consumed || attempt.expiresAt <= now()
          || (!input.error && (!validId(input.code) || input.code.length > 512))) throw new GoogleStateError('invalid_callback');
        const flow = binding.self.flows.consume(input.state, now());
        attempt.consumed = true;
        if (!flow || flow.redirectUri !== binding.self.redirectUri) throw new GoogleStateError('invalid_callback');
        if (input.error) {
          if (!attempt.cancelled) set(slot, { state: 'error', attemptId: attempt.id,
            message: 'Google sign-in was denied. Try again, or skip for now.' }, 'consent_denied');
          return snapshot(binding, slot);
        }
        try {
          await binding.self.auth.exchangeCode(input.code!, { codeVerifier: flow.codeVerifier });
          binding.self.onTokensSaved();
        } catch {
          if (!attempt.cancelled) set(slot, { state: 'error', attemptId: attempt.id,
            message: 'Google sign-in could not finish. Try again, or skip for now.' }, 'exchange_failed');
          return snapshot(binding, slot);
        }
        return refresh(binding, slot, attempt.id);
      });
    },
  };
}
