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
import { withTrustedTrailer } from '../../roles/untrusted.ts';

/**
 * The separator between the page and this module's own instructions.
 *
 * It lives here now, and it is FORMATTING rather than a protocol. Until #560 it
 * was exported from roles/untrusted.ts because `markUntrustedToolResult` had to
 * search the tool result for it to decide where the untrusted block ended --
 * locating a trust boundary by searching attacker-controlled text. The
 * instructions now travel beside the page in a carrier
 * (`withTrustedTrailer`), so nothing looks for this string and it matters only
 * to the reader.
 */
const SITE_INSTRUCTIONS_SEPARATOR = '\n\n---\nYou are now on ';

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
   * Attach the site's template instructions to a browser tool result when the
   * page URL resolves to a known webapp template that hasn't been delivered
   * recently in this conversation. Error and detached-dispatch results, empty
   * results and unknown URLs pass through untouched.
   *
   * Returns either the result unchanged, or a CARRIER holding the page and the
   * instructions separately (#560). The caller frames the page and places the
   * instructions after the closing delimiter; nothing has to find a seam. The
   * return type is `unknown` because that is what `ToolDefinition.execute`
   * promises -- every consumer must go through `splitToolReturn` or
   * `toolReturnText`, never `JSON.stringify`.
   */
  withInstructions(result: string, fallbackUrl?: string): unknown {
    if (result.startsWith('Error')) return result;
    if (result.startsWith(DETACHED_RESULT_PREFIX)) return result;
    // An empty result is not a page, so it gets no playbook. Without this a
    // carrier could hold an empty payload and a non-empty trailer, which forces
    // every consumer to decide what "the tool returned nothing, but here is a
    // playbook" means -- and it would burn the redelivery TTL on a non-visit,
    // losing the instructions for the next 30 minutes.
    if (result.length === 0) return result;

    const url = extractSnapshotUrl(result) ?? fallbackUrl;
    if (!url) return result;

    const resolved = getWebappInstructionsForUrl(url);
    if (!resolved) return result;

    const last = this.delivered.get(resolved.templateId);
    const now = Date.now();
    if (last !== undefined && now - last < REDELIVER_AFTER_MS) return result;
    this.delivered.set(resolved.templateId, now);

    // Carried beside the page, not concatenated onto it: these are repo-authored
    // instructions (seeded by vault/webapp-template-seeds.ts, not writable by any
    // tool) and they must render OUTSIDE the untrusted block. Handing them over
    // separately is what lets the framing layer place them there without
    // searching the page for a boundary.
    return withTrustedTrailer(result, [
      `${SITE_INSTRUCTIONS_SEPARATOR}${resolved.appName}. Follow these site-specific instructions while operating it:`,
      '',
      resolved.instructions,
    ].join('\n'));
  }
}

/** Delivery state for the main agent's global browser tools. */
export const globalWebappTemplateDelivery = new WebappTemplateDelivery();
