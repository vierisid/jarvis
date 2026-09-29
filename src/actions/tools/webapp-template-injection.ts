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
 *
 * WHICH page it is, is the CALLER's to say (#572). This module is handed a URL;
 * it never derives one from the tool result, because the tool result is a
 * rendered page and a page would then be choosing its own playbook. Which URL a
 * caller may pass, and why a sidecar-routed browser has none to give, is settled
 * once above the browser tools in builtin.ts.
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
 * Longest URL this module will look up. Real page URLs are far shorter; the cap
 * is here because a URL is OUTSIDE CONTENT even when it arrives structurally,
 * and a megabyte of `data:` is not a page identity worth resolving.
 */
const MAX_LOOKUP_URL_LENGTH = 2048;

/**
 * The page URL, if it is one this module is willing to resolve.
 *
 * `browserUrl` is Chrome's answer rather than the page's, so a page cannot claim
 * another site's origin -- but it still chooses its own path (`history.pushState`),
 * and the document itself can be `data:` or `blob:`. Structural is not trusted:
 * so length is capped, and anything carrying a control character (a newline
 * above all, which is what would let a value break a log line or a rendered
 * field it later lands in) is refused outright rather than trimmed. Refusing
 * costs at most one site playbook.
 */
function usablePageUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.length > MAX_LOOKUP_URL_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  // And it must be a SITE. A playbook says "you are now on Gmail"; a `data:` or
  // `blob:` document has no site to be on, and its bytes are the attacker's in
  // full -- so `data:text/html,<!--.mail.google.com` was enough to be handed
  // Gmail's playbook, because the matcher falls back to treating a URL it cannot
  // parse as a bare hostname and then suffix-matches it. That fallback is gone
  // too (vault/webapp-templates.ts); this is the half that belongs here, where
  // the question is "is this a page identity at all".
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return url;
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
   * page the browser is ON resolves to a known webapp template that hasn't been
   * delivered recently in this conversation. Unknown and absent URLs, and empty
   * results, pass through untouched.
   *
   * `pageUrl` is REQUIRED and structural (#572). It is the caller's answer to
   * "which page is this?", and the caller is the only one who can answer it: a
   * local snapshot has `PageSnapshot.browserUrl` from Chrome's frame tree, a
   * sidecar navigate has the URL it asked for, and anything that did not land on
   * a page -- an error, a detached dispatch -- passes null. Until #572 this
   * function answered the question itself, by regexing a `URL:` line out of
   * `result`. `result` is a RENDERED PAGE: its first line is `Page: <title>` and
   * a page picks its own title, newlines included, so a page could print a
   * second `URL:` line and (no `/g`, first match wins) choose the playbook it
   * was handed. Nothing here reads `result` any more except to carry it.
   *
   * Returns either the result unchanged, or a CARRIER holding the page and the
   * instructions separately (#560). The caller frames the page and places the
   * instructions after the closing delimiter; nothing has to find a seam. The
   * return type is `unknown` because that is what `ToolDefinition.execute`
   * promises -- every consumer must go through `splitToolReturn` or
   * `toolReturnText`, never `JSON.stringify`.
   */
  withInstructions(result: string, pageUrl: string | null): unknown {
    // An empty result is not a page, so it gets no playbook. Without this a
    // carrier could hold an empty payload and a non-empty trailer, which forces
    // every consumer to decide what "the tool returned nothing, but here is a
    // playbook" means -- and it would burn the redelivery TTL on a non-visit,
    // losing the instructions for the next 30 minutes. A length check on the
    // payload about to be carried, not a reading of it.
    if (result.length === 0) return result;

    const url = usablePageUrl(pageUrl);
    if (!url) return result;

    // Only `templateId`, `appName` and `instructions` come back, all of them
    // vault-authored -- the URL itself goes no further than this lookup, and in
    // particular never into the trailer the model reads.
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
