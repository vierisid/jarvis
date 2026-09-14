/**
 * Event Classifier — Priority Router
 *
 * Classifies ObserverEvents into priority levels using rule-based logic.
 * No LLM calls — must be instant. Critical/high events trigger immediate
 * reactions; normal/low events get batched for the next heartbeat.
 */

import type { ObserverEvent } from '../observers/index.ts';
import { getDueCommitments, getUpcoming } from '../vault/commitments.ts';

export type EventPriority = 'critical' | 'high' | 'normal' | 'low';

export type ClassifiedEvent = {
  event: ObserverEvent;
  priority: EventPriority;
  reason: string;
};

// Patterns that suggest high-intent clipboard content
const URL_PATTERN = /https?:\/\/\S+/i;
const EMAIL_PATTERN = /[\w.-]+@[\w.-]+\.\w{2,}/;
const PHONE_PATTERN = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

// Directories where file changes are low-priority noise
const LOW_PRIORITY_DIRS = ['/tmp', '/var/tmp', '/dev/shm', 'node_modules', '.git', '__pycache__', '.cache'];

/**
 * Classify an observer event into a priority level.
 * Rules are evaluated top-down; first match wins.
 */
export function classifyEvent(event: ObserverEvent): ClassifiedEvent {
  const { type, data } = event;

  // --- Commitment-related events (injected by heartbeat checks) ---
  if (type === 'commitment_overdue') {
    return { event, priority: 'critical', reason: `Commitment overdue: ${data.what}` };
  }

  if (type === 'commitment_due_soon') {
    return { event, priority: 'high', reason: `Commitment due within 15 min: ${data.what}` };
  }

  // --- Clipboard events ---
  if (type === 'clipboard') {
    const text = String(data.content ?? '');

    if (text.length < 3) {
      return { event, priority: 'low', reason: 'Clipboard: trivial content' };
    }

    if (URL_PATTERN.test(text)) {
      return { event, priority: 'high', reason: 'Clipboard contains URL — possible intent to browse/research' };
    }

    if (EMAIL_PATTERN.test(text)) {
      return { event, priority: 'high', reason: 'Clipboard contains email address — possible intent to contact' };
    }

    if (PHONE_PATTERN.test(text)) {
      return { event, priority: 'high', reason: 'Clipboard contains phone number' };
    }

    if (text.length > 200) {
      return { event, priority: 'normal', reason: 'Clipboard: substantial text copied' };
    }

    return { event, priority: 'low', reason: 'Clipboard: short text' };
  }

  // --- File change events ---
  if (type === 'file_change') {
    const filePath = String(data.path ?? '');
    const changeType = String(data.changeType ?? data.type ?? '');

    // Check if file is in a low-priority directory
    if (LOW_PRIORITY_DIRS.some(dir => filePath.includes(dir))) {
      return { event, priority: 'low', reason: `File change in noisy directory: ${filePath}` };
    }

    // Large file deletions are noteworthy
    if (changeType === 'delete' || changeType === 'rename') {
      return { event, priority: 'high', reason: `File ${changeType}: ${filePath}` };
    }

    return { event, priority: 'normal', reason: `File modified: ${filePath}` };
  }

  // --- Process events ---
  if (type === 'process_started') {
    const name = String(data.name ?? data.command ?? '');

    // Interesting process launches
    if (/chrome|firefox|code|slack|discord|telegram|zoom/i.test(name)) {
      return { event, priority: 'normal', reason: `Notable app launched: ${name}` };
    }

    return { event, priority: 'low', reason: `Process started: ${name}` };
  }

  if (type === 'process_stopped') {
    return { event, priority: 'low', reason: `Process stopped: ${data.name ?? data.pid}` };
  }

  // --- Notification events ---
  if (type === 'notification') {
    const urgency = String(data.urgency ?? '');

    if (urgency === 'critical') {
      return { event, priority: 'critical', reason: `System notification (critical): ${data.summary}` };
    }

    return { event, priority: 'normal', reason: `System notification: ${data.summary}` };
  }

  // --- Calendar / Email events ---
  if (type === 'calendar') {
    return { event, priority: 'high', reason: `Calendar event: ${data.summary ?? data.title}` };
  }

  if (type === 'email') {
    const subject = String(data.subject ?? '');
    const labels = Array.isArray(data.labels) ? data.labels as string[] : [];

    // IMPORTANT/STARRED labels → high priority
    if (labels.includes('IMPORTANT') || labels.includes('STARRED')) {
      return { event, priority: 'high', reason: `Important email: ${subject}` };
    }

    // Urgent keywords in subject
    const urgentKeywords = /\b(urgent|asap|critical|emergency|action required|immediate|deadline)\b/i;
    if (urgentKeywords.test(subject)) {
      return { event, priority: 'high', reason: `Urgent email: ${subject}` };
    }

    return { event, priority: 'normal', reason: `New email: ${subject || 'no subject'}` };
  }

  // --- Awareness events (M13) ---
  if (type === 'error_detected') {
    return { event, priority: 'high', reason: `Screen error detected: ${data.errorText} in ${data.appName}` };
  }

  if (type === 'struggle_detected') {
    const score = data.compositeScore as number;
    const priority = score >= 0.7 ? 'high' : 'normal';
    return { event, priority, reason: `User struggling in ${data.appName} (score: ${score?.toFixed(2)}, ${data.appCategory})` };
  }

  if (type === 'stuck_detected') {
    return { event, priority: 'normal', reason: `User appears stuck in ${data.appName} (${Math.round((data.durationMs as number) / 1000)}s)` };
  }

  if (type === 'context_changed') {
    return { event, priority: 'low', reason: `Switched from ${data.fromApp} to ${data.toApp}` };
  }

  if (type === 'session_started' || type === 'session_ended') {
    return { event, priority: 'low', reason: `Activity session ${type === 'session_started' ? 'started' : 'ended'}` };
  }

  if (type === 'suggestion_ready') {
    return { event, priority: 'normal', reason: `Awareness suggestion: ${data.title}` };
  }

  if (type === 'screen_capture') {
    return { event, priority: 'low', reason: `Screen captured (${Math.round((data.pixelChangePct as number) * 100)}% change)` };
  }

  // --- Sidecar events ---
  if (type === 'sidecar_register') {
    return { event, priority: 'normal', reason: `Sidecar registered: ${data.name ?? data.sidecar_id}` };
  }

  if (type === 'sidecar_disconnect') {
    return { event, priority: 'normal', reason: `Sidecar disconnected: ${data.name ?? data.sidecar_id}` };
  }

  if (type === 'sidecar_rpc_error') {
    return { event, priority: 'high', reason: `Sidecar RPC error: ${data.error ?? data.method} on ${data.name ?? data.sidecar_id}` };
  }

  if (type === 'sidecar_rpc_complete') {
    return { event, priority: 'low', reason: `Sidecar RPC complete: ${data.method} on ${data.name ?? data.sidecar_id}` };
  }

  if (type.startsWith('sidecar_')) {
    return { event, priority: 'normal', reason: `Sidecar event: ${type}` };
  }

  // --- Default ---
  return { event, priority: 'low', reason: `Unclassified event: ${type}` };
}

/**
 * Check commitments and generate synthetic events for due/overdue items.
 * Called periodically (e.g., every heartbeat) to inject commitment-awareness.
 */
export function checkCommitments(): ClassifiedEvent[] {
  const events: ClassifiedEvent[] = [];

  try {
    // Check overdue commitments
    const overdue = getDueCommitments({ excludeWorkItems: true });
    for (const c of overdue) {
      events.push({
        event: {
          type: 'commitment_overdue',
          data: { id: c.id, what: c.what, when_due: c.when_due, priority: c.priority },
          timestamp: Date.now(),
        },
        priority: 'critical',
        reason: `Commitment overdue: ${c.what}`,
      });
    }

    // Check commitments due within 15 minutes
    const upcoming = getUpcoming(10, { excludeWorkItems: true });
    const fifteenMinFromNow = Date.now() + 15 * 60 * 1000;

    for (const c of upcoming) {
      if (c.when_due && c.when_due <= fifteenMinFromNow && c.when_due > Date.now()) {
        events.push({
          event: {
            type: 'commitment_due_soon',
            data: { id: c.id, what: c.what, when_due: c.when_due, priority: c.priority },
            timestamp: Date.now(),
          },
          priority: 'high',
          reason: `Commitment due within 15 min: ${c.what}`,
        });
      }
    }
  } catch (err) {
    console.error('[EventClassifier] Error checking commitments:', err);
  }

  return events;
}
