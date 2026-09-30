/**
 * Document Tool
 *
 * Allows the agent to create, read, update, and list documents stored
 * in the vault. Use this instead of write_file when creating reports,
 * plans, analyses, or any document the user should be able to download.
 *
 * NO DOWNLOAD CARD. `create` used to render an HTML comment carrying the new
 * document's id into its own result text, and `agents/orchestrator.ts` regexed
 * it back out of the FRAMED tool result to emit into the assistant's turn --
 * reading past the untrusted delimiters on purpose, so any page text that
 * reached a tool result could forge a download card (#584).
 *
 * That marker string is now spelled in exactly one place, `documents.test.ts`,
 * whose guard asserts that nothing in `src` or `ui/src` spells it at all --
 * neither to write it nor to look for it. Deliberately not repeated here: the
 * guard is only absolute if this file does not reintroduce the needle.
 *
 * The whole path is gone rather than made structural, because it had no
 * consumer to be correct for: `ui/src/components/chat/DocumentCard.tsx` and the
 * `MarkdownContent.tsx` parser that found the marker were deleted in f7f2eea0
 * (the Monochrome Lab rebrand), today's `ui/src/v2/thread/MarkdownBody.tsx` runs
 * react-markdown with no `rehype-raw` so a raw HTML comment is dropped, and the
 * orchestrator's non-streaming loop overwrote the text it had accumulated
 * anyway. Meanwhile the tool's own description promised the user a card, so the
 * model asserted something the UI could not deliver -- an active defect, and
 * worse than the dead code carrying it. A marker that does not exist cannot be
 * forged, which makes deleting it the strongest available fix for #584.
 *
 * To bring the affordance back, emit a TYPED STREAM EVENT from the tool loop
 * (the stream already carries a discriminated `type`) rather than a marker in
 * prose, and restore a renderer for it. That is UI product work, not a security
 * fix. `documents.test.ts` pins that the marker stays gone in the meantime.
 *
 * The document itself is still downloadable: `/api/documents/:id/download`
 * serves it by id, and `create` returns that id to the model.
 */

import type { ToolDefinition } from './registry.ts';
import type { DocumentFormat } from '../../vault/documents.ts';
import { DOCUMENT_FORMATS } from '../../vault/documents.ts';
import {
  createDocument, getDocument, findDocuments, updateDocument, deleteDocument,
} from '../../vault/documents.ts';

/**
 * Lower-case a caller's `format` so it matches what the column can hold.
 *
 * Two validators disagree about case, and this reconciles them. The registry
 * matches the `format` enum CASE-INSENSITIVELY and passes the value through
 * unchanged on purpose (see registry.ts), while the table's
 * `CHECK(format IN ('markdown', ...))` (vault/schema.ts) is SQLite `IN` on TEXT
 * with no `COLLATE NOCASE`, so it is case-SENSITIVE. Without this, `"MarkDown"`
 * clears the enum and then fails the CHECK.
 *
 * So this turns calls that used to FAIL into calls that succeed. It is not
 * repairing stored data: the CHECK has been on the table since it was created
 * (ae61f208), so no row has ever held a value outside the six, in any case --
 * there is nothing to migrate and the `?? '.txt'` fallbacks in the download
 * route were already unreachable.
 */
function normalizedFormat(raw: unknown): DocumentFormat | undefined {
  return typeof raw === 'string' ? (raw.toLowerCase() as DocumentFormat) : undefined;
}

export const documentTool: ToolDefinition = {
  name: 'create_document',
  // Says what the tool actually does and nothing it cannot deliver. It used to
  // promise "create shows them a download card in chat"; nothing has rendered
  // such a card since f7f2eea0, so the model was asserting something false to
  // the user (#584).
  //
  // The replacement clause carries the URL rather than just saying "the user
  // downloads it by that id", because there is no documents room in `ui/src`
  // and nothing there calls `/api/documents` -- so "by that id" would have been
  // the same unsupported promise one step quieter, with no way for the model to
  // tell the user how. The route is real: api-routes.ts serves by id with
  // Content-Disposition: attachment.
  //
  // Deliberately NOT here: any line telling the model not to claim a download
  // card. Nothing else in the product mentions one any more, so forbidding it
  // would introduce the idea in order to ban it -- and it cost 50 of the 48
  // bytes of remaining schema budget.
  description: [
    'Create, read, update, append, list or delete vault documents: reports, plans, analyses.',
    'Prefer this over write_file for anything the user may want to keep or download.',
    'create returns the new document id; it downloads from /api/documents/<id>/download.',
    'For a publishing pipeline, use content_pipeline instead.',
    'For a long document, create the first section then append the rest;',
    'one oversized body is truncated by the output token limit.',
  ].join('\n'),
  category: 'documents',
  parameters: {
    action: {
      type: 'string',
      description: 'What to do.',
      enum: ['create', 'get', 'list', 'update', 'append', 'delete'],
      required: true,
    },
    id: {
      type: 'string',
      description: 'Document id; required for get/update/append/delete.',
      required: false,
    },
    title: {
      type: 'string',
      description: 'Title; required for create.',
      required: false,
    },
    body: {
      type: 'string',
      description: 'Full body for create/update; the text to add for append.',
      required: false,
    },
    format: {
      type: 'string',
      // The allowed values are emitted from `enum`, so listing them here too
      // would spend the description budget saying the same thing twice.
      description: 'Defaults to markdown.',
      // Enumerated to move the rejection EARLIER, not to create one. An
      // out-of-set format was always refused -- by the table's
      // `CHECK(format IN (...))` -- but as a raw `SQLiteError: CHECK constraint
      // failed`, which registry.ts wraps as "Tool 'create_document' execution
      // failed: ..." and hands the model as an opaque dead end. The enum
      // refuses it before the write and names the six allowed values in the
      // message, so the model corrects itself on the next turn.
      //
      // Derived from `DOCUMENT_FORMATS` so this list cannot drift from the
      // `DocumentFormat` union it advertises.
      enum: [...DOCUMENT_FORMATS],
      required: false,
    },
    tags: {
      type: 'string',
      description: 'Comma-separated tags; also filters list.',
      required: false,
    },
    search: {
      type: 'string',
      description: 'Search term for list; matches title and body.',
      required: false,
    },
  },
  execute: async (params) => {
    const action = params.action as string;

    switch (action) {
      case 'create': {
        if (!params.title) return 'Error: "title" is required for create action';
        const tags = params.tags ? (params.tags as string).split(',').map(t => t.trim()) : undefined;
        const doc = createDocument(
          params.title as string,
          (params.body as string) ?? '',
          {
            format: normalizedFormat(params.format) ?? 'markdown',
            tags,
          },
        );
        // No marker, and nothing carried beside the result either: see the
        // header. The id goes in the TEXT, which is all the model needs to
        // reference or download the document, and is not a structure anything
        // parses back out.
        const preview = doc.body.length > 200 ? doc.body.slice(0, 200) + '...' : doc.body;
        return [
          `Document created: "${doc.title}" (${doc.format}, ${doc.body.length} chars)`,
          `Id: ${doc.id}`,
          // The blank line belongs INSIDE this element: `.filter(Boolean)`
          // strips a bare '' separator, so a standalone one never rendered.
          preview ? `\nPreview:\n${preview}` : '',
        ].filter(Boolean).join('\n');
      }

      case 'get': {
        if (!params.id) return 'Error: "id" is required for get action';
        const doc = getDocument(params.id as string);
        if (!doc) return `Document not found: ${params.id}`;
        return [
          `Title: ${doc.title}`,
          `Format: ${doc.format}`,
          `Tags: ${doc.tags.join(', ') || 'none'}`,
          `Size: ${doc.body.length} chars`,
          `Created: ${new Date(doc.created_at).toLocaleString()}`,
          `Updated: ${new Date(doc.updated_at).toLocaleString()}`,
          '',
          '--- Content ---',
          doc.body || '(empty)',
        ].join('\n');
      }

      case 'list': {
        const query: { format?: DocumentFormat; tag?: string; search?: string } = {};
        // Normalised like create and update, and for a sharper reason: this one
        // does not throw. `findDocuments` runs `format = ?` against a column
        // that can only hold lowercase, so an un-normalised `"MarkDown"` clears
        // the case-insensitive enum and then matches nothing -- the model gets
        // an empty list and tells the user they have no such documents.
        if (params.format) query.format = normalizedFormat(params.format);
        if (params.tags) query.tag = params.tags as string;
        if (params.search) query.search = params.search as string;
        const docs = findDocuments(Object.keys(query).length > 0 ? query : undefined);
        if (docs.length === 0) return 'No documents found.';
        return docs.map(d =>
          `[${d.id}] "${d.title}" (${d.format}, ${d.body.length} chars) - tags: ${d.tags.join(', ') || 'none'}, updated: ${new Date(d.updated_at).toLocaleString()}`
        ).join('\n');
      }

      case 'update': {
        if (!params.id) return 'Error: "id" is required for update action';
        const updates: Record<string, unknown> = {};
        if (params.title !== undefined) updates.title = params.title;
        if (params.body !== undefined) updates.body = params.body;
        if (params.format !== undefined) updates.format = normalizedFormat(params.format);
        if (params.tags !== undefined) {
          updates.tags = (params.tags as string).split(',').map(t => t.trim());
        }
        const updated = updateDocument(params.id as string, updates);
        if (!updated) return `Document not found: ${params.id}`;
        return `Updated: "${updated.title}" - ${updated.body.length} chars`;
      }

      case 'append': {
        if (!params.id) return 'Error: "id" is required for append action';
        if (!params.body) return 'Error: "body" is required for append action (the text to append)';
        const existing = getDocument(params.id as string);
        if (!existing) return `Document not found: ${params.id}`;
        const newBody = existing.body + (existing.body ? '\n\n' : '') + (params.body as string);
        const updated = updateDocument(params.id as string, { body: newBody });
        if (!updated) return 'Failed to append to document';
        return `Appended ${(params.body as string).length} chars. Total: ${updated.body.length} chars for "${updated.title}"`;
      }

      case 'delete': {
        if (!params.id) return 'Error: "id" is required for delete action';
        const deleted = deleteDocument(params.id as string);
        if (!deleted) return `Document not found: ${params.id}`;
        return 'Document deleted.';
      }

      default:
        return `Unknown action: "${action}". Valid actions: create, get, list, update, append, delete`;
    }
  },
};
