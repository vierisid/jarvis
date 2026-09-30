/**
 * The rendered form of a download card (#584).
 *
 * ONE place spells the marker, and nothing reads it back. Before #584
 * `documents.ts` rendered this comment into its own result text and
 * `agents/orchestrator.ts` recovered it with a regex over the FRAMED tool
 * result -- reading past the delimiters on purpose, because that is where the
 * marker was. A page whose text reached that result could therefore forge a
 * card, and framing could not help: the block was being read into deliberately.
 *
 * The id, title, format and size are known structurally by the producer, so
 * they now travel beside the result on the `withDocumentCard` carrier and this
 * function renders them once, at the point the orchestrator emits the card into
 * the assistant's turn. The rendered string is repo-authored from that point
 * on, and no regex recovers anything.
 *
 * NOTHING CONSUMES THIS MARKER TODAY, which is worth knowing before extending
 * it. The renderer that turned it into a download button --
 * `ui/src/components/chat/DocumentCard.tsx` and the `MarkdownContent.tsx`
 * parser that found it -- was deleted in f7f2eea0 (the Monochrome Lab
 * rebrand). Today's chat renderer is `ui/src/v2/thread/MarkdownBody.tsx`:
 * react-markdown with `remark-gfm` and no `rehype-raw`, so a raw HTML comment
 * is dropped and renders as nothing. The non-streaming loop cannot even deliver
 * it as text, because it assigns `finalText = llmResponse.content` after the
 * tool loop has accumulated into it.
 *
 * So the "one producer and no readers" guard in
 * roles/untrusted-import-guard.test.ts records a SYMPTOM, not a goal: #584
 * removed the reader that parsed page-controlled text, and the reader that
 * rendered the affordance was already gone. The affordance itself wants a
 * decision -- restore a consumer (better: a typed stream event, which would
 * delete this whole module), or drop the emission and the "download card"
 * language from the tool description. That is a product call, not #584's.
 */

import type { DocumentCard } from '../../roles/untrusted.ts';

/**
 * Neutralise a value that goes into the comment's attributes.
 *
 * The title is a free model-authored string, so it can hold a quote, a
 * newline, or `-->`. `format` is enum-checked by the registry as of #584 and
 * normalised by `documents.ts`, so it is no longer a way in THROUGH the
 * registry -- but `documentTool.execute` is callable directly, which bypasses
 * `validateParameters` entirely (the tests do it), so neither value is assumed
 * clean here. None of that is an
 * injection into the page -- the chat renderer is `react-markdown` with no
 * `rehype-raw`, so a raw HTML comment is never parsed as HTML -- but a `-->`
 * would end the comment early and spill the rest as visible text, and a newline
 * would break it across lines. So the attributes are reduced to a single line
 * with no quote and no comment-closing sequence, and bounded.
 *
 * This is escaping for a rendered form, not a trust boundary: nothing decides
 * anything by matching this text.
 */
function attr(value: string, maxChars: number): string {
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/"/g, "'")
    // Both directions: `-->` closes a comment and `<!--` would nest one. The
    // optional `!` covers the comment-end-bang form `--!>`, which a real HTML
    // parser also treats as the end of a comment.
    .replace(/--+!?>/g, '- >')
    .replace(/<!--+/g, '< !-')
    .trim();
  const chars = Array.from(flat);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') + '...' : flat;
}

/** The marker the chat turn carries so the UI can offer the download. */
export function renderDocumentCard(card: DocumentCard): string {
  return `<!-- jarvis:document id="${attr(card.id, 64)}" title="${attr(card.title, 200)}" `
    + `format="${attr(card.format, 32)}" size="${Number.isFinite(card.size) ? Math.trunc(card.size) : 0}" -->`;
}
