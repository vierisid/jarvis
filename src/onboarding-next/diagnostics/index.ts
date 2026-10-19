import { createHmac, randomBytes } from 'node:crypto';
import { identity, normalize } from './normalize.ts';
import { createLoggerAbortController } from './logger-abort.ts';
import { LIMITS, type DeliveryState, type DiagnosticEvent, type Options, type Receipt, type RecordResult } from './types.ts';
export * from './types.ts';
export { observeOperation } from './observe.ts';

interface Journal {
  scopeId: string; journeyId: string; events: DiagnosticEvent[];
  seen: Map<string, string>; sequence: number;
  evictedEvents: number; duplicateEvents: number; conflictingEvents: number; droppedDeliveries: number;
}
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

/** Dormant, bounded, process-local diagnostics. No IO, logger call, random key
 * creation or timer occurs during construction. No production sink is selected. */
export function createDiagnosticsProvider<Context>(options: Options<Context>) {
  const journals = new Map<string, Journal>();
  const queue: Array<{ event: DiagnosticEvent; journal: Journal }> = [];
  let key: Uint8Array | undefined;
  let closed = false;
  let delivery: DeliveryState = options.logger ? 'idle' : 'absent';
  let cancelActive: (() => void) | undefined;
  const timeout = Number.isFinite(options.deliveryTimeoutMs) ? Math.max(1, Math.min(1000, options.deliveryTimeoutMs!)) : 100;
  function hash(field: string, value: string) {
    if (!key) {
      if (options.correlationKey !== undefined && (!(options.correlationKey instanceof Uint8Array) || options.correlationKey.byteLength < 32 || options.correlationKey.byteLength > 128)) throw new Error('Invalid diagnostic key');
      key = options.correlationKey ? new Uint8Array(options.correlationKey) : randomBytes(32);
    }
    return 'd1_' + createHmac('sha256', key).update(JSON.stringify([field, value])).digest('hex').slice(0, 32);
  }
  function scopeFor(context: Context): string | null {
    if (options.enabled !== true) return null;
    const scope = options.authorize(context);
    return scope && identity(scope.actorId) && identity(scope.projectId)
      ? hash('scope', JSON.stringify([scope.actorId, scope.projectId])) : null;
  }
  function dropQueue() {
    for (const item of queue.splice(0)) item.journal.droppedDeliveries = increment(item.journal.droppedDeliveries);
  }
  function drain() {
    if (cancelActive || closed || !options.logger || delivery === 'failed' || delivery === 'timed_out') return;
    const item = queue.shift(); if (!item) { delivery = 'idle'; return; }
    delivery = 'pending';
    const abort = createLoggerAbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: 'idle' | 'failed' | 'timed_out' | 'closed') => {
      if (settled) return;
      settled = true; clearTimeout(timer); cancelActive = undefined;
      delivery = outcome;
      if (outcome !== 'idle') {
        item.journal.droppedDeliveries = increment(item.journal.droppedDeliveries);
        // Settle accounting before callbacks can dispose or record reentrantly.
        dropQueue(); abort.abort();
      } else queueMicrotask(drain);
    };
    cancelActive = () => finish('closed');
    timer = setTimeout(() => finish('timed_out'), timeout);
    try {
      // The logger sees a detached projection. Its mutations cannot taint a receipt.
      Promise.resolve(options.logger(structuredClone(item.event), abort.signal)).then(() => finish('idle'), () => finish('failed'));
    } catch { finish('failed'); }
  }
  return {
    /** Observational B11-compatible probe; diagnostics never gates onboarding. */
    probe() { return { ready: options.enabled === true && !closed, reason: options.enabled === true && !closed ? 'ready' as const : 'disabled' as const }; },
    /** No public HTTP operation exposes receipts or accepts analytics from clients. */
    operations: {},
    record(context: Context, input: unknown): RecordResult {
      try {
        if (closed) return 'unavailable';
        const scopeId = scopeFor(context); if (!scopeId) return 'unavailable';
        const event = normalize(input, (field, value) => hash(scopeId + ':' + field, value));
        if (!event) return 'invalid';
        const journalKey = event.correlation.journeyId;
        let journal = journals.get(journalKey);
        if (!journal) {
          if (journals.size >= LIMITS.journeys) journals.delete(journals.keys().next().value!);
          journal = { scopeId, journeyId: journalKey, events: [], seen: new Map(), sequence: 0,
            evictedEvents: 0, duplicateEvents: 0, conflictingEvents: 0, droppedDeliveries: 0 };
          journals.set(journalKey, journal);
        } else { journals.delete(journalKey); journals.set(journalKey, journal); }
        const digest = JSON.stringify(event), prior = journal.seen.get(event.eventId);
        if (prior !== undefined) {
          if (prior === digest) { journal.duplicateEvents = increment(journal.duplicateEvents); return 'duplicate'; }
          journal.conflictingEvents = increment(journal.conflictingEvents); return 'conflict';
        }
        if (journal.seen.size >= LIMITS.dedup) journal.seen.delete(journal.seen.keys().next().value!);
        journal.seen.set(event.eventId, digest);
        const recorded: DiagnosticEvent = { ...event, sequence: journal.sequence = increment(journal.sequence) };
        if (journal.events.length >= LIMITS.events) { journal.events.shift(); journal.evictedEvents = increment(journal.evictedEvents); }
        journal.events.push(recorded);
        if (options.logger) {
          if (delivery === 'failed' || delivery === 'timed_out' || queue.length >= LIMITS.queue) journal.droppedDeliveries = increment(journal.droppedDeliveries);
          else { queue.push({ event: recorded, journal }); queueMicrotask(drain); }
        }
        return 'recorded';
      } catch { return 'invalid'; }
    },
    receipt(context: Context, journeyId: string): Receipt | null {
      try {
        const scopeId = scopeFor(context); if (!scopeId || !identity(journeyId)) return null;
        const journal = journals.get(hash(scopeId + ':journeyId', journeyId));
        if (!journal) return null;
        return { schemaVersion: 1, kind: 'onboarding_diagnostics', scopeId, journeyId: journal.journeyId,
          events: structuredClone(journal.events), evictedEvents: journal.evictedEvents,
          duplicateEvents: journal.duplicateEvents, conflictingEvents: journal.conflictingEvents,
          delivery, droppedDeliveries: journal.droppedDeliveries };
      } catch { return null; }
    },
    dispose() {
      if (closed) return;
      closed = true; delivery = 'closed'; cancelActive?.(); dropQueue();
    },
  };
}
