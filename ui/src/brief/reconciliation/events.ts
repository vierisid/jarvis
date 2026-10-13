import type { Domain } from './resource';
export interface Frame { type: string; payload?: unknown }
const all: readonly Domain[] = ['goals', 'today', 'decisions', 'opportunities', 'workflows', 'runs', 'memory'];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** A cursor is meaningful only within its producer/connection lifetime. No event is domain state. */
export class EventHints {
  private seen = new Set<string>();
  private cursors = new Map<string, number>();
  reset() { this.seen.clear(); this.cursors.clear(); }
  accept(frame: Frame): readonly Domain[] {
    const p = record(frame?.payload);
    let domains: readonly Domain[] = [];
    let stream: string | undefined;
    if (frame?.type === 'goal_event') { domains = all; stream = 'goals'; }
    else if (frame?.type === 'workflow_event') domains = ['today', 'decisions', 'workflows', 'runs', 'memory'];
    else if (frame?.type === 'brief_chat_event' || frame?.type === 'brief_chat_audio') {
      // The producer allocates one sequence for both event and transient audio frames.
      if (typeof p.conversationId === 'string') stream = `chat:${p.conversationId}`;
      if (frame.type === 'brief_chat_event') {
        if (record(p.payload).kind === 'approval') domains = ['decisions', 'today', 'runs'];
        else if (record(p.payload).kind === 'terminal') domains = ['today', 'opportunities', 'memory'];
      }
    } else if (frame?.type === 'notification') {
      if (p.source === 'approval_request' || p.source === 'approval_update') domains = ['decisions', 'today', 'runs'];
      else if (p.source === 'awareness_event') domains = ['opportunities', 'memory', 'today'];
    } else if (frame?.type === 'settings_applied') domains = all;

    // Only producer-issued IDs are deduplicated. Legacy notifications have no stable ID.
    const key = stream && typeof p.eventId === 'string' && p.eventId ? `${stream}\0${p.eventId}` : null;
    if (key && this.seen.has(key)) return [];
    if (key) {
      this.seen.add(key);
      if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    }
    if (stream && Number.isSafeInteger(p.sequence) && (p.sequence as number) > 0) {
      const sequence = p.sequence as number, previous = this.cursors.get(stream);
      // An unfamiliar older message still invalidates its domain; never roll the cursor back.
      if (previous !== undefined && sequence > previous + 1) domains = all;
      this.cursors.set(stream, Math.max(previous ?? 0, sequence));
      if (this.cursors.size > 128) this.cursors.delete(this.cursors.keys().next().value!);
    }
    return domains;
  }
}
