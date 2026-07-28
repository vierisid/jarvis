/**
 * Webapp template delivery — URL-driven, at browse time.
 *
 * When browser_navigate or browser_snapshot observes a page whose URL belongs
 * to a known webapp template, the template's instructions are appended ONCE to
 * the tool result. The block then lives in conversation history, so follow-up
 * turns keep the playbook without any message matching. Mentioning an app in
 * conversation never triggers delivery — only actually being on the site does.
 */

import { getWebappInstructionsForUrl } from '../../vault/webapp-templates.ts';

/**
 * Re-deliver a template after this long. Long sessions can outlive context
 * compaction; without a TTL the playbook would be lost for good once the
 * original tool result is trimmed from history.
 */
const REDELIVER_AFTER_MS = 30 * 60_000;

/** templateId → last delivery timestamp. Per-process, like the browser session. */
const delivered = new Map<string, number>();

/** Test hook: forget all deliveries. */
export function resetDeliveredWebappTemplates(): void {
  delivered.clear();
}

/** Test hook: backdate a delivery to exercise the TTL. */
export function backdateDeliveredWebappTemplate(templateId: string, deliveredAt: number): void {
  if (delivered.has(templateId)) delivered.set(templateId, deliveredAt);
}

/**
 * Pull the page URL out of a formatted snapshot ("Page: …\nURL: …"). Works on
 * both the local formatSnapshot output and the sidecar's parity-formatted
 * string, so delivery behaves the same for remote browsers.
 */
export function extractSnapshotUrl(result: string): string | null {
  const match = result.match(/^URL: (\S+)$/m);
  return match ? match[1]! : null;
}

/**
 * Append the site's template instructions to a browser tool result when the
 * page URL resolves to a known webapp template that hasn't been delivered
 * recently. Error results and unknown URLs pass through untouched.
 */
export function withWebappTemplateInstructions(result: string, fallbackUrl?: string): string {
  if (result.startsWith('Error')) return result;

  const url = extractSnapshotUrl(result) ?? fallbackUrl;
  if (!url) return result;

  const resolved = getWebappInstructionsForUrl(url);
  if (!resolved) return result;

  const last = delivered.get(resolved.templateId);
  const now = Date.now();
  if (last !== undefined && now - last < REDELIVER_AFTER_MS) return result;
  delivered.set(resolved.templateId, now);

  return [
    result,
    '',
    '---',
    `You are now on ${resolved.appName}. Follow these site-specific instructions while operating it:`,
    '',
    resolved.instructions,
  ].join('\n');
}
