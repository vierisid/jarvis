/**
 * Content Pipeline Tool
 *
 * Allows the agent to manage the content pipeline:
 * list, get, create, update, advance stage, add notes, get notes.
 *
 * IMPORTANT: For long content (drafts, scripts, articles), use append_body
 * to write in chunks rather than sending the entire text in a single update.
 * This avoids token limit truncation.
 */

import type { ToolDefinition } from './registry.ts';
import type { ContentStage, ContentType } from '../../vault/content-pipeline.ts';
import {
  createContent, getContent, findContent, updateContent,
  advanceStage, regressStage,
  addStageNote, getStageNotes,
  CONTENT_STAGES, CONTENT_TYPES,
} from '../../vault/content-pipeline.ts';

export const contentPipelineTool: ToolDefinition = {
  name: 'content_pipeline',
  description: [
    'Track publishable content (video, post, article, newsletter) through its pipeline stages.',
    'Stages: ' + CONTENT_STAGES.join(' -> ') + '.',
    'advance and regress step one stage along that ladder; add_note and',
    'get_notes attach notes to a stage. For a one-off report or download, use',
    'create_document instead.',
    'Write a long body as repeated append_body calls; one oversized set_body is',
    'cut off by the output token limit. To rewrite, set_body "" first.',
  ].join('\n'),
  category: 'content',
  parameters: {
    action: {
      type: 'string',
      description: 'What to do.',
      enum: ['list', 'get', 'create', 'update', 'set_body', 'append_body', 'advance', 'regress', 'add_note', 'get_notes'],
      required: true,
    },
    id: {
      type: 'string',
      description: 'Content item id; required for every action except list and create.',
      required: false,
    },
    title: {
      type: 'string',
      description: 'Title; required for create.',
      required: false,
    },
    body: {
      type: 'string',
      description: 'Body text: replaces the body for set_body, is appended for append_body. Keep under 1000 words per call.',
      required: false,
    },
    content_type: {
      type: 'string',
      description: 'One of: ' + CONTENT_TYPES.join(', ') + '. Also filters list.',
      required: false,
    },
    stage: {
      type: 'string',
      description: 'Pipeline stage: filters list, sets the stage on update, required for add_note, optional filter for get_notes.',
      required: false,
    },
    tags: {
      type: 'string',
      description: 'Comma-separated tags; also filters list.',
      required: false,
    },
    note: {
      type: 'string',
      description: 'Note text; required for add_note.',
      required: false,
    },
  },
  execute: async (params) => {
    const action = params.action as string;

    switch (action) {
      case 'list': {
        const query: { stage?: ContentStage; content_type?: ContentType; tag?: string } = {};
        if (params.stage) query.stage = params.stage as ContentStage;
        if (params.content_type) query.content_type = params.content_type as ContentType;
        if (params.tags) query.tag = params.tags as string;
        const items = findContent(query);
        if (items.length === 0) return 'No content items found matching the criteria.';
        return items.map(i =>
          `[${i.id}] "${i.title}" (${i.content_type}) — stage: ${i.stage}, tags: ${i.tags.join(', ') || 'none'}, updated: ${new Date(i.updated_at).toLocaleString()}`
        ).join('\n');
      }

      case 'get': {
        if (!params.id) return 'Error: "id" is required for get action';
        const item = getContent(params.id as string);
        if (!item) return `Content item not found: ${params.id}`;
        return [
          `Title: ${item.title}`,
          `Type: ${item.content_type}`,
          `Stage: ${item.stage}`,
          `Tags: ${item.tags.join(', ') || 'none'}`,
          `Created by: ${item.created_by}`,
          `Created: ${new Date(item.created_at).toLocaleString()}`,
          `Updated: ${new Date(item.updated_at).toLocaleString()}`,
          `Body length: ${item.body.length} chars`,
          item.scheduled_at ? `Scheduled: ${new Date(item.scheduled_at).toLocaleString()}` : null,
          item.published_url ? `Published URL: ${item.published_url}` : null,
          '',
          '--- Body ---',
          item.body || '(empty)',
        ].filter(Boolean).join('\n');
      }

      case 'create': {
        if (!params.title) return 'Error: "title" is required for create action';
        const tags = params.tags ? (params.tags as string).split(',').map(t => t.trim()) : undefined;
        const item = createContent(params.title as string, {
          body: params.body as string | undefined,
          content_type: params.content_type as ContentType | undefined,
          stage: params.stage as ContentStage | undefined,
          tags,
          created_by: 'jarvis',
        });
        return `Created content item: [${item.id}] "${item.title}" (${item.content_type}, stage: ${item.stage})`;
      }

      case 'update': {
        if (!params.id) return 'Error: "id" is required for update action';
        const updates: Record<string, unknown> = {};
        if (params.title !== undefined) updates.title = params.title;
        if (params.content_type !== undefined) updates.content_type = params.content_type;
        if (params.stage !== undefined) updates.stage = params.stage;
        if (params.tags !== undefined) {
          updates.tags = (params.tags as string).split(',').map(t => t.trim());
        }
        // Note: body is NOT handled here. Use set_body or append_body instead.
        const updated = updateContent(params.id as string, updates);
        if (!updated) return `Content item not found: ${params.id}`;
        return `Updated: [${updated.id}] "${updated.title}" — stage: ${updated.stage}, body: ${updated.body.length} chars`;
      }

      case 'set_body': {
        if (!params.id) return 'Error: "id" is required for set_body action';
        if (params.body === undefined) return 'Error: "body" is required for set_body action';
        const updated = updateContent(params.id as string, { body: params.body as string });
        if (!updated) return `Content item not found: ${params.id}`;
        return `Body set: ${updated.body.length} chars saved for "${updated.title}"`;
      }

      case 'append_body': {
        if (!params.id) return 'Error: "id" is required for append_body action';
        if (!params.body) return 'Error: "body" is required for append_body action (the text to append)';
        const existing = getContent(params.id as string);
        if (!existing) return `Content item not found: ${params.id}`;
        const newBody = existing.body + (existing.body ? '\n\n' : '') + (params.body as string);
        const updated = updateContent(params.id as string, { body: newBody });
        if (!updated) return `Failed to append body`;
        return `Appended ${(params.body as string).length} chars. Total body: ${updated.body.length} chars for "${updated.title}"`;
      }

      case 'advance': {
        if (!params.id) return 'Error: "id" is required for advance action';
        const advanced = advanceStage(params.id as string);
        if (!advanced) return 'Cannot advance: item not found or already at last stage (published).';
        return `Advanced to stage: ${advanced.stage} — "${advanced.title}"`;
      }

      case 'regress': {
        if (!params.id) return 'Error: "id" is required for regress action';
        const regressed = regressStage(params.id as string);
        if (!regressed) return 'Cannot regress: item not found or already at first stage (idea).';
        return `Regressed to stage: ${regressed.stage} — "${regressed.title}"`;
      }

      case 'add_note': {
        if (!params.id) return 'Error: "id" is required for add_note action';
        if (!params.stage) return 'Error: "stage" is required for add_note action';
        if (!params.note) return 'Error: "note" is required for add_note action';
        const stageNote = addStageNote(
          params.id as string,
          params.stage as ContentStage,
          params.note as string,
          'jarvis',
        );
        return `Note added to ${stageNote.stage} stage: "${stageNote.note.slice(0, 100)}${stageNote.note.length > 100 ? '...' : ''}"`;
      }

      case 'get_notes': {
        if (!params.id) return 'Error: "id" is required for get_notes action';
        const notes = getStageNotes(
          params.id as string,
          params.stage as ContentStage | undefined,
        );
        if (notes.length === 0) return 'No notes found.';
        return notes.map(n =>
          `[${n.stage}] (${n.author}, ${new Date(n.created_at).toLocaleString()}): ${n.note}`
        ).join('\n');
      }

      default:
        return `Unknown action: "${action}". Valid actions: list, get, create, update, set_body, append_body, advance, regress, add_note, get_notes`;
    }
  },
};
