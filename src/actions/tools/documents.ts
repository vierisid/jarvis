/**
 * Document Tool
 *
 * Allows the agent to create, read, update, and list documents stored
 * in the vault. Use this instead of write_file when creating reports,
 * plans, analyses, or any document the user should be able to download.
 *
 * Returns a document marker that the dashboard renders as a card with
 * a download button.
 */

import type { ToolDefinition } from './registry.ts';
import type { DocumentFormat } from '../../vault/documents.ts';
import {
  createDocument, getDocument, findDocuments, updateDocument, deleteDocument,
} from '../../vault/documents.ts';

export const documentTool: ToolDefinition = {
  name: 'create_document',
  description: [
    'Create, read, update, or list documents stored in the vault.',
    'Use this tool instead of write_file when producing reports, plans, analyses,',
    'guides, summaries, or any document the user may want to download.',
    '',
    'Actions:',
    '  create — Create a new document (returns a preview card in chat)',
    '  get    — Read a document by ID',
    '  list   — List all documents, optionally filtered',
    '  update — Update an existing document',
    '  append — Append text to an existing document (for long content)',
    '  delete — Delete a document',
    '',
    'Formats: markdown, plain, html, json, csv, code',
    '',
    'IMPORTANT: For long documents, use create first with the initial section,',
    'then use append to add remaining sections. This prevents token truncation.',
    '',
    'When you create a document, a download card is shown to the user in chat.',
  ].join('\n'),
  category: 'documents',
  parameters: {
    action: {
      type: 'string',
      description: 'The action: create, get, list, update, append, delete',
      required: true,
    },
    id: {
      type: 'string',
      description: 'Document ID (required for get, update, append, delete)',
      required: false,
    },
    title: {
      type: 'string',
      description: 'Document title (required for create, optional for update)',
      required: false,
    },
    body: {
      type: 'string',
      description: 'Document content. For create/update: full body. For append: text to add.',
      required: false,
    },
    format: {
      type: 'string',
      description: 'Document format: markdown (default), plain, html, json, csv, code',
      required: false,
    },
    tags: {
      type: 'string',
      description: 'Comma-separated tags for create/update/filter',
      required: false,
    },
    search: {
      type: 'string',
      description: 'Search term for list action (searches title and body)',
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
            format: (params.format as DocumentFormat) ?? 'markdown',
            tags,
          },
        );
        // Return the document marker + preview for the chat UI
        const preview = doc.body.length > 200 ? doc.body.slice(0, 200) + '...' : doc.body;
        return [
          `Document created: "${doc.title}" (${doc.format}, ${doc.body.length} chars)`,
          '',
          `<!-- jarvis:document id="${doc.id}" title="${doc.title}" format="${doc.format}" size="${doc.body.length}" -->`,
          '',
          preview ? `Preview:\n${preview}` : '',
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
        if (params.format !== undefined) updates.format = params.format;
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
