/**
 * Webapp template delivery — URL-driven, at browse time.
 *
 * When browser_navigate or browser_snapshot observes a page whose URL belongs
 * to a known webapp template, the template's instructions are appended ONCE to
 * the tool result. The block then lives in conversation history, so follow-up
 * turns keep the playbook without any message matching. Mentioning an app in
 * conversation never triggers delivery — only actually being on the site does.
 *
 * Delivery state is scoped per WebappTemplateDelivery instance, one per LLM
 * conversation's tool set (the main agent's global tools and each background
 * agent's bound tools are separate conversations with separate histories — a
 * delivery into one must never suppress delivery into another).
 */

import { getWebappInstructionsForUrl } from '../../vault/webapp-templates.ts';

/**
 * Re-deliver a template after this long. Long sessions can outlive context
 * compaction; without a TTL the playbook would be lost for good once the
 * original tool result is trimmed from history.
 */
const REDELIVER_AFTER_MS = 30 * 60_000;

/**
 * A sidecar dispatch that went detached returns this prefix (sidecar-route.ts)
 * — the navigation outcome is unknown, so no template is delivered; the next
 * browser_snapshot will deliver it once the page is actually there.
 */
const DETACHED_RESULT_PREFIX = 'Task dispatched to ';

/**
 * Pull the page URL out of a formatted snapshot ("Page: …\nURL: …"). Works on
 * both the local formatSnapshot output and the sidecar's parity-formatted
 * string, so delivery behaves the same for remote browsers.
 */
export function extractSnapshotUrl(result: string): string | null {
  const match = result.match(/^URL: (\S+)$/m);
  return match ? match[1]! : null;
}

export class WebappTemplateDelivery {
  /** templateId → last delivery timestamp. */
  private delivered = new Map<string, number>();

  /** Test hook: forget all deliveries. */
  reset(): void {
    this.delivered.clear();
  }

  /** Test hook: backdate a delivery to exercise the TTL. */
  backdate(templateId: string, deliveredAt: number): void {
    if (this.delivered.has(templateId)) this.delivered.set(templateId, deliveredAt);
  }

  /**
   * Append the site's template instructions to a browser tool result when the
   * page URL resolves to a known webapp template that hasn't been delivered
   * recently in this conversation. Error and detached-dispatch results and
   * unknown URLs pass through untouched.
   */
  withInstructions(result: string, fallbackUrl?: string): string {
    if (result.startsWith('Error')) return result;
    if (result.startsWith(DETACHED_RESULT_PREFIX)) return result;

    const url = extractSnapshotUrl(result) ?? fallbackUrl;
    if (!url) return result;

    const resolved = getWebappInstructionsForUrl(url);
    if (!resolved) return result;

    const last = this.delivered.get(resolved.templateId);
    const now = Date.now();
    if (last !== undefined && now - last < REDELIVER_AFTER_MS) return result;
    this.delivered.set(resolved.templateId, now);

    return [
      result,
      '',
      '---',
      `You are now on ${resolved.appName}. Follow these site-specific instructions while operating it:`,
      '',
      resolved.instructions,
    ].join('\n');
  }
}

/** Delivery state for the main agent's global browser tools. */
export const globalWebappTemplateDelivery = new WebappTemplateDelivery();
