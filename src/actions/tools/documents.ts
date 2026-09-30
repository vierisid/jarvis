/**
 * Document Tool
 *
 * Allows the agent to create, read, update, and list documents stored
 * in the vault. Use this instead of write_file when creating reports,
 * plans, analyses, or any document the user should be able to download.
 *
 * `create` hands back a download card beside its result (#584). The
 * orchestrator's streaming loop renders it into the assistant's turn -- though
 * nothing in the UI consumes it today; see actions/tools/document-card.ts.
 */

import type { ToolDefinition } from './registry.ts';
import type { DocumentFormat } from '../../vault/documents.ts';
import {
  createDocument, getDocument, findDocuments, updateDocument, deleteDocument,
} from '../../vault/documents.ts';
import { withDocumentCard } from '../../roles/untrusted.ts';

/**
 * Lower-case a caller's `format` so it matches the keys the rest of the product
 * looks it up by.
 *
 * The registry validates the `format` enum CASE-INSENSITIVELY and passes the
 * value through unchanged on purpose (see registry.ts), so `"Markdown"` is
 * accepted and would be stored verbatim -- and
 * `/api/documents/:id/download` does exact-key lookups for the extension and
 * MIME type, so it would silently fall back to `.txt` / `text/plain`.
 * Normalising here is what makes the stored format, the download and the card
 * agree instead of the enum merely narrowing what is rejected.
 */
function normalizedFormat(raw: unknown): DocumentFormat | undefined {
  return typeof raw === 'string' ? (raw.toLowerCase() as DocumentFormat) : undefined;
}

export const documentTool: ToolDefinition = {
  name: 'create_document',
  description: [
    'Create, read, update or list vault documents: reports, plans, analyses, guides, summaries.',
    'Prefer this over write_file for anything the user may want to download;',
    'create shows them a download card in chat. For content moving through a',
    'publishing pipeline, use content_pipeline instead.',
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
      description: 'markdown (default), plain, html, json, csv, code',
      // Enumerated so the value is CHECKED, not just documented. It was a bare
      // string cast to `DocumentFormat` and stored raw, so the model -- which a
      // page's text can steer -- could put arbitrary text in it, and that text
      // then surfaced in the download card's `format` attribute (#584). The
      // registry rejects an out-of-enum value and reports the allowed ones back
      // to the model. It matches case-insensitively and does not normalise, so
      // `normalizedFormat` above does that half.
      enum: ['markdown', 'plain', 'html', 'json', 'csv', 'code'],
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
        // The download card travels BESIDE the result, not inside it (#584).
        // It used to be rendered into this text as an HTML comment and the
        // orchestrator regexed it back out of the framed tool result, so any
        // page text that reached a result could forge a card. The id, title,
        // format and size are known right here, structurally, so they are
        // handed over as data and `document-card.ts` renders them once, in the
        // orchestrator, on the way into the assistant's turn.
        //
        // The marker is also gone from what the MODEL reads, which is the other
        // half of the win: it can no longer echo a card into its own reply.
        const preview = doc.body.length > 200 ? doc.body.slice(0, 200) + '...' : doc.body;
        return withDocumentCard(
          [
            `Document created: "${doc.title}" (${doc.format}, ${doc.body.length} chars)`,
            '',
            preview ? `Preview:\n${preview}` : '',
          ].filter(Boolean).join('\n'),
          { id: doc.id, title: doc.title, format: doc.format, size: doc.body.length },
        );
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
        if (params.format) query.format = params.format as DocumentFormat;
        if (params.tags) query.tag = params.tags as string;
        if (params.search) query.search = params.search as string;
        const docs = findDocuments(Object.keys(query).length > 0 ? query : undefined);
        if (docs.length === 0) return 'No documents found.';
        return docs.map(d =>
          `[${d.id}] "${d.title}" (${d.format}, ${d.body.length} chars) — tags: ${d.tags.join(', ') || 'none'}, updated: ${new Date(d.updated_at).toLocaleString()}`
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
        return `Updated: "${updated.title}" — ${updated.body.length} chars`;
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
