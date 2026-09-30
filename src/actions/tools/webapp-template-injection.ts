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
 * delivery into one must never suppress delivery into another), and WITHIN an
 * instance by the ambient delivery scope (#586). The instance alone was not
 * enough: one ToolRegistry is built at daemon startup and the module-level
 * browser tools go into it, so the global instance is shared by every chat
 * conversation, by the approval executor, by every workflow step and by every
 * delegated sub-agent. See `template-delivery-scope.ts` for who enters what.
 *
 * WHICH page it is, is the CALLER's to say (#572). This module is handed a URL;
 * it never derives one from the tool result, because the tool result is a
 * rendered page and a page would then be choosing its own playbook. Which URL a
 * caller may pass, and why a sidecar-routed browser has none to give, is settled
 * once above the browser tools in builtin.ts.
 */

import { getWebappInstructionsForUrl } from '../../vault/webapp-templates.ts';
import { withTrustedTrailer } from '../../roles/untrusted.ts';
import { currentTemplateDeliveryScope } from './template-delivery-scope.ts';

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

/**
 * The scope a delivery is recorded against when no caller named one (#586).
 *
 * A named scope cannot spell it, because a named scope's key is its id under
 * `NAMED_SCOPE_PREFIX` and this one carries no prefix. That is worth a line of
 * code rather than a line of prose: the ids are `crypto.randomUUID()` today, and
 * the whole reason this module grew a scope is that a later one may not be.
 */
const DEFAULT_SCOPE = 'default';

/** Namespaces a caller-supplied scope id away from `DEFAULT_SCOPE`. */
const NAMED_SCOPE_PREFIX = 'named:';

export class WebappTemplateDelivery {
  /**
   * scope -> templateId -> last delivery timestamp (#586).
   *
   * NESTED rather than one map under a `${scope}|${templateId}` string key.
   * There is no delimiter, so no id can be spelled to reach another scope's
   * entry, and forgetting a whole scope is one `delete`. Both matter more than
   * they look: the scope ids in play are UUIDs today, and the reason this
   * module has a scope at all is that a future one may be human-readable.
   */
  private delivered = new Map<string, Map<string, number>>();

  /** Test hook: forget all deliveries. */
  reset(): void {
    this.delivered.clear();
  }

  /**
   * Test hook: backdate a delivery to exercise the TTL.
   *
   * Every scope's entry for the template, because a test that backdates asks
   * "what happens once this has expired", and which scope recorded it is the
   * business of the code under test rather than of the test.
   */
  backdate(templateId: string, deliveredAt: number): void {
    for (const perTemplate of this.delivered.values()) {
      if (perTemplate.has(templateId)) perTemplate.set(templateId, deliveredAt);
    }
  }

  /** Test hook: how many scopes are being remembered, for the prune. */
  scopeCountForTests(): number {
    return this.delivered.size;
  }

  /**
   * Note a delivery, and drop everything that has outlived the TTL.
   *
   * The prune is here rather than on a timer because an entry past its TTL
   * carries no information -- `withInstructions` would re-deliver on sight of
   * it -- so dropping it changes no behaviour and costs one pass over a map
   * that is at most (scopes x templates) long. Without it the scope dimension
   * is unbounded in the number of sub-agent runs, and this daemon is expected
   * to stay up for weeks.
   */
  private record(scope: string, templateId: string, now: number): void {
    for (const [key, perTemplate] of this.delivered) {
      for (const [id, at] of perTemplate) {
        if (now - at >= REDELIVER_AFTER_MS) perTemplate.delete(id);
      }
      if (perTemplate.size === 0 && key !== scope) this.delivered.delete(key);
    }
    const perTemplate = this.delivered.get(scope) ?? new Map<string, number>();
    perTemplate.set(templateId, now);
    this.delivered.set(scope, perTemplate);
  }

  /**
   * Attach the site's template instructions to a browser tool result when the
   * page the browser is ON resolves to a known webapp template that hasn't been
   * delivered recently in this conversation. Unknown and absent URLs, empty
   * results, and calls from a suppressed delivery scope pass through untouched.
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

    // Before the lookup and before anything is recorded (#586): a context that
    // cannot use a playbook must not spend one. The workflow tool adapter is
    // the case that named the bug -- it drops the trailer (#581), so resolving
    // a template there could only take the delivery away from the chat model.
    const scope = currentTemplateDeliveryScope();
    if (scope?.kind === 'suppressed') return result;
    const scopeKey = scope?.kind === 'named' ? `${NAMED_SCOPE_PREFIX}${scope.id}` : DEFAULT_SCOPE;

    const url = usablePageUrl(pageUrl);
    if (!url) return result;

    // Only `templateId`, `appName` and `instructions` come back, all of them
    // vault-authored -- the URL itself goes no further than this lookup, and in
    // particular never into the trailer the model reads.
    const resolved = getWebappInstructionsForUrl(url);
    if (!resolved) return result;

    const last = this.delivered.get(scopeKey)?.get(resolved.templateId);
    const now = Date.now();
    if (last !== undefined && now - last < REDELIVER_AFTER_MS) return result;
    this.record(scopeKey, resolved.templateId, now);

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
