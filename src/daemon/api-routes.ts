/**
 * REST API Routes
 *
 * Thin handlers over vault functions and daemon services.
 * Returns a routes object for Bun.serve().
 */

import type { HealthMonitor } from './health.ts';
import type { AgentService } from './agent-service.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { EntityType } from '../vault/entities.ts';
import type { CommitmentPriority, CommitmentStatus } from '../vault/commitments.ts';
import type { ObservationType } from '../vault/observations.ts';
import type { ContentStage, ContentType } from '../vault/content-pipeline.ts';
import type { AuthorityEngine } from '../authority/engine.ts';
import type { ApprovalManager } from '../authority/approval.ts';
import type { AuditTrail, AuthorityDecisionType } from '../authority/audit.ts';
import type { AuthorityLearner } from '../authority/learning.ts';
import type { EmergencyController } from '../authority/emergency.ts';
import type { DeferredExecutor } from '../authority/deferred-executor.ts';
import type { ActionCategory } from '../roles/authority.ts';

import { findEntities, getEntity, searchEntitiesByName } from '../vault/entities.ts';
import { findFacts } from '../vault/facts.ts';
import { findRelationships, getEntityRelationships } from '../vault/relationships.ts';
import { getDb } from '../vault/schema.ts';
import { findCommitments, getUpcoming, createCommitment, getCommitment, updateCommitmentStatus, reorderCommitments } from '../vault/commitments.ts';
import { getOrCreateConversation, getMessages, getRecentConversation } from '../vault/conversations.ts';
import { getRecentObservations } from '../vault/observations.ts';
import { getPersonality } from '../personality/model.ts';
import { clearUserProfile, getUserProfile, saveUserProfile } from '../vault/user-profile.ts';
import {
  USER_PROFILE_QUESTIONS,
  countAnsweredUserProfileQuestions,
  hasUserProfile,
} from '../user/profile.ts';
import {
  createContent, getContent, findContent, updateContent, deleteContent,
  advanceStage, regressStage,
  addStageNote, getStageNotes,
  addAttachment, getAttachment, getAttachments, deleteAttachment,
  CONTENT_STAGES, CONTENT_TYPES,
} from '../vault/content-pipeline.ts';
import {
  assignPersistentAgentTask,
  HttpError,
  listPersistentAgents,
  spawnPersistentAgent,
  terminatePersistentAgent,
} from '../actions/tools/agents.ts';

import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Security helpers ---

/** HTML-escape to prevent XSS in inline HTML responses */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Sanitize a single path segment — strip directory separators and dot-dot sequences */
function sanitizePathSegment(segment: string): string {
  return path.basename(segment.replace(/\.\./g, ''));
}

/** Validate that a resolved path is within the expected base directory */
function isWithinBase(resolvedPath: string, baseDir: string): boolean {
  const normalizedBase = path.resolve(baseDir) + path.sep;
  const normalizedPath = path.resolve(resolvedPath);
  return normalizedPath.startsWith(normalizedBase) || normalizedPath === path.resolve(baseDir);
}

/** Escape SQL LIKE wildcard characters in user input */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

/** Sanitize a filename for Content-Disposition headers */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- .]/g, '');
}

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'text/javascript',
  'image/svg+xml',
  'application/x-httpd-php',
  'application/x-sh',
  'application/x-csh',
]);

import type { WebSocketService } from './ws-service.ts';
import type { ChannelService } from './channel-service.ts';

import type { AwarenessService } from '../awareness/service.ts';
import { readFileSync } from 'node:fs';
import {
  getCapture,
  getRecentCaptures,
  getCapturesInRange,
} from '../vault/awareness.ts';
import type { SuggestionType } from '../awareness/types.ts';
import {
  getAutostartName,
  isAutostartInstalled,
  scheduleAutostartRestart,
} from '../cli/autostart.ts';

export type ApiContext = {
  healthMonitor: HealthMonitor;
  agentService: AgentService;
  config: JarvisConfig;
  wsService?: WebSocketService;
  channelService?: ChannelService;
  authorityEngine?: AuthorityEngine;
  approvalManager?: ApprovalManager;
  auditTrail?: AuditTrail;
  learner?: AuthorityLearner;
  emergencyController?: EmergencyController;
  deferredExecutor?: DeferredExecutor;
  awarenessService?: AwarenessService | null;
  workflowEngine?: import('../workflows/engine.ts').WorkflowEngine;
  triggerManager?: import('../workflows/triggers/manager.ts').TriggerManager;
  webhookManager?: import('../workflows/triggers/webhook.ts').WebhookManager;
  nodeRegistry?: import('../workflows/nodes/registry.ts').NodeRegistry;
  nlBuilder?: import('../workflows/nl-builder.ts').NLWorkflowBuilder;
  autoSuggest?: import('../workflows/auto-suggest.ts').WorkflowAutoSuggest;
  goalService?: import('../goals/service.ts').GoalService;
  sidecarManager?: import('../sidecar/manager.ts').SidecarManager;
  siteBuilderService?: import('../sites/service.ts').SiteBuilderService;
};

// CORS headers — scoped to the dashboard origin, not wildcard
let CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'http://localhost:3142',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Call once during init to set the correct CORS origin from config */
export function setCorsOrigin(port: number, host = 'localhost') {
  CORS = {
    'Access-Control-Allow-Origin': `http://${host}:${port}`,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function errorFromException(err: unknown): Response {
  if (err instanceof HttpError) return error(err.message, err.status);
  return error(err instanceof Error ? err.message : String(err), 500);
}

function getSearchParams(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

type AgentTaskSnapshot = {
  id: string;
  agentId: string;
  status: string;
  task: string;
  startedAt: number;
  completedAt?: number | null;
};

function buildAgentSnapshots(ctx: ApiContext) {
  const orchestrator = ctx.agentService.getOrchestrator();
  const taskManager = ctx.agentService.getTaskManager();
  const latestTaskByAgent = new Map<string, AgentTaskSnapshot>();
  const busyAgents = new Set<string>();

  if (taskManager) {
    for (const task of taskManager.listTasks()) {
      if (!task.agentId) continue;
      if (!task.completedAt) {
        busyAgents.add(task.agentId);
      }

      const existing = latestTaskByAgent.get(task.agentId);
      if (!existing || task.startedAt >= existing.startedAt) {
        latestTaskByAgent.set(task.agentId, task);
      }
    }
  }

  const agents = orchestrator.getAllAgents().map((agent) => {
    const base = agent.toJSON();
    const latestTask = latestTaskByAgent.get(agent.id);
    return {
      ...base,
      busy: busyAgents.has(agent.id),
      latest_task: latestTask ? {
        id: latestTask.id,
        status: latestTask.status,
        task: latestTask.task,
        started_at: latestTask.startedAt,
        completed_at: latestTask.completedAt,
      } : null,
    };
  });

  return {
    agents,
    latestTaskByAgent,
    taskManager,
  };
}

/**
 * Create all API route handlers.
 */
export function createApiRoutes(ctx: ApiContext): Record<string, unknown> {
  return {
    // --- Health ---
    '/api/health': {
      GET: () => json(ctx.healthMonitor.getHealth()),
    },

    // --- Vault: Entities ---
    '/api/vault/entities': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const type = params.get('type') as EntityType | null;
        const q = params.get('q');
        const query: { type?: EntityType; nameContains?: string } = {};
        if (type) query.type = type;
        if (q) query.nameContains = q;
        return json(findEntities(query));
      },
    },

    '/api/vault/entities/:id': {
      GET: (req: Request & { params: { id: string } }) => {
        const entity = getEntity(req.params.id);
        if (!entity) return error('Entity not found', 404);
        return json(entity);
      },
    },

    '/api/vault/entities/:id/facts': {
      GET: (req: Request & { params: { id: string } }) => {
        return json(findFacts({ subject_id: req.params.id }));
      },
    },

    '/api/vault/entities/:id/relationships': {
      GET: (req: Request & { params: { id: string } }) => {
        return json(getEntityRelationships(req.params.id));
      },
    },

    // --- Vault: Facts ---
    '/api/vault/facts': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const query: { subject_id?: string; predicate?: string; object?: string } = {};
        const subjectId = params.get('subject_id');
        const predicate = params.get('predicate');
        const object = params.get('object');
        if (subjectId) query.subject_id = subjectId;
        if (predicate) query.predicate = predicate;
        if (object) query.object = object;
        return json(findFacts(query));
      },
    },

    // --- Vault: Relationships ---
    '/api/vault/relationships': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const query: { from_id?: string; to_id?: string; type?: string } = {};
        const fromId = params.get('from_id');
        const toId = params.get('to_id');
        const type = params.get('type');
        if (fromId) query.from_id = fromId;
        if (toId) query.to_id = toId;
        if (type) query.type = type;
        return json(findRelationships(query));
      },
    },

    // --- Vault: Unified Search ---
    '/api/vault/search': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const q = params.get('q')?.trim() || '';
        const type = params.get('type') as EntityType | null;
        const limit = Math.min(parseInt(params.get('limit') ?? '50') || 50, 200);

        const db = getDb();
        const entityIds = new Set<string>();

        if (q) {
          // 1. Search entities by name
          const nameMatches = searchEntitiesByName(q);
          for (const e of nameMatches) entityIds.add(e.id);

          // 2. Search facts by predicate or object
          const safeQ = escapeLike(q);
          const factRows = db.prepare(
            "SELECT DISTINCT subject_id FROM facts WHERE predicate LIKE ? ESCAPE '\\' OR object LIKE ? ESCAPE '\\' LIMIT 200"
          ).all(`%${safeQ}%`, `%${safeQ}%`) as { subject_id: string }[];
          for (const r of factRows) entityIds.add(r.subject_id);

          // 3. Search relationships by type
          const relRows = db.prepare(
            "SELECT from_id, to_id FROM relationships WHERE type LIKE ? ESCAPE '\\' LIMIT 200"
          ).all(`%${safeQ}%`) as { from_id: string; to_id: string }[];
          for (const r of relRows) {
            entityIds.add(r.from_id);
            entityIds.add(r.to_id);
          }
        } else {
          // No query — return all entities
          const allEntities = findEntities(type ? { type } : {});
          for (const e of allEntities) entityIds.add(e.id);
        }

        // Filter by type if specified
        const results: Array<{
          entity: ReturnType<typeof getEntity>;
          facts: ReturnType<typeof findFacts>;
          relationships: Array<{ type: string; target: string; direction: 'from' | 'to' }>;
        }> = [];

        for (const id of entityIds) {
          if (results.length >= limit) break;
          const entity = getEntity(id);
          if (!entity) continue;
          if (type && entity.type !== type) continue;

          const facts = findFacts({ subject_id: id });
          const rels = getEntityRelationships(id);
          const relationships = rels.map(r => ({
            type: r.type,
            target: r.from_id === id ? r.to_entity.name : r.from_entity.name,
            direction: (r.from_id === id ? 'from' : 'to') as 'from' | 'to',
          }));

          results.push({ entity, facts, relationships });
        }

        // Sort by updated_at desc
        results.sort((a, b) => (b.entity!.updated_at) - (a.entity!.updated_at));

        return json(results);
      },
    },

    // --- Vault: Commitments ---
    '/api/vault/commitments': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const status = params.get('status') as CommitmentStatus | null;
        const priority = params.get('priority') as CommitmentPriority | null;
        const assignedTo = params.get('assigned_to');
        const overdue = params.get('overdue');
        const upcoming = params.get('upcoming');

        if (upcoming) {
          return json(getUpcoming(parseInt(upcoming) || 10));
        }

        const query: {
          status?: CommitmentStatus;
          priority?: CommitmentPriority;
          assigned_to?: string;
          overdue?: boolean;
        } = {};
        if (status) query.status = status;
        if (priority) query.priority = priority;
        if (assignedTo) query.assigned_to = assignedTo;
        if (overdue === 'true') query.overdue = true;
        return json(findCommitments(query));
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as {
            what: string;
            when_due?: number;
            context?: string;
            priority?: CommitmentPriority;
            assigned_to?: string;
          };
          if (!body.what) return error('Missing "what" field');
          const commitment = createCommitment(body.what, {
            when_due: body.when_due,
            context: body.context,
            priority: body.priority,
            assigned_to: body.assigned_to,
          });
          ctx.wsService?.broadcastTaskUpdate(commitment, 'created');
          return json(commitment, 201);
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    '/api/vault/commitments/reorder': {
      POST: async (req: Request) => {
        try {
          const body = await req.json() as { items: { id: string; sort_order: number }[] };
          if (!body.items || !Array.isArray(body.items)) return error('Missing "items" array');
          reorderCommitments(body.items);
          return json({ ok: true });
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    '/api/vault/commitments/:id': {
      GET: (req: Request & { params: { id: string } }) => {
        const commitment = getCommitment(req.params.id);
        if (!commitment) return error('Commitment not found', 404);
        return json(commitment);
      },
      PATCH: async (req: Request & { params: { id: string } }) => {
        try {
          const body = await req.json() as { status?: CommitmentStatus; result?: string };
          const id = req.params.id;

          if (!body.status) return error('Missing "status" field');

          const validStatuses: CommitmentStatus[] = ['pending', 'active', 'completed', 'failed', 'escalated'];
          if (!validStatuses.includes(body.status)) {
            return error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
          }

          const updated = updateCommitmentStatus(id, body.status, body.result);
          if (!updated) return error('Commitment not found', 404);
          ctx.wsService?.broadcastTaskUpdate(updated, 'updated');
          return json(updated);
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    // --- Vault: Conversations ---
    '/api/vault/conversations': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const channel = params.get('channel');
        const limit = Math.min(parseInt(params.get('limit') ?? '20') || 20, 100);

        const db = getDb();
        let rows;
        if (channel && channel !== 'all') {
          rows = db.prepare(
            'SELECT * FROM conversations WHERE channel = ? ORDER BY last_message_at DESC LIMIT ?'
          ).all(channel, limit);
        } else {
          rows = db.prepare(
            'SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT ?'
          ).all(limit);
        }
        return json(rows);
      },
    },

    '/api/vault/conversations/active': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const channel = params.get('channel') ?? 'websocket';

        if (channel === 'all') {
          // Return the most recent conversation per channel
          const channels = ['websocket', 'telegram', 'discord'];
          const results: Record<string, unknown> = {};
          for (const ch of channels) {
            const result = getRecentConversation(ch);
            if (result) results[ch] = result;
          }
          return json(results);
        }

        const result = getRecentConversation(channel);
        if (!result) return json({ conversation: null, messages: [] });
        return json(result);
      },
    },

    '/api/vault/conversations/:id/messages': {
      GET: (req: Request & { params: { id: string } }) => {
        const params = getSearchParams(req);
        const limit = parseInt(params.get('limit') ?? '100') || 100;
        const messages = getMessages(req.params.id, { limit });
        return json(messages);
      },
    },

    // --- Vault: Observations ---
    '/api/vault/observations': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const type = params.get('type') as ObservationType | undefined;
        const limit = parseInt(params.get('limit') ?? '50') || 50;
        return json(getRecentObservations(type, limit));
      },
    },

    // --- Calendar (unified view of scheduled commitments + content) ---
    '/api/calendar': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const rangeStart = parseInt(params.get('range_start') ?? '0');
        const rangeEnd = parseInt(params.get('range_end') ?? '0');

        if (!rangeStart || !rangeEnd) {
          return error('Missing range_start and/or range_end (Unix ms timestamps)');
        }

        const db = getDb();
        const events: Array<{
          id: string;
          type: 'commitment' | 'content';
          title: string;
          timestamp: number;
          status: string;
          priority?: string;
          content_type?: string;
          stage?: string;
          assigned_to?: string;
          has_due_date?: boolean;
        }> = [];

        // Commitments with when_due in range
        const dueRows = db.prepare(
          'SELECT * FROM commitments WHERE when_due IS NOT NULL AND when_due >= ? AND when_due < ?'
        ).all(rangeStart, rangeEnd) as any[];

        for (const row of dueRows) {
          events.push({
            id: row.id,
            type: 'commitment',
            title: row.what,
            timestamp: row.when_due,
            status: row.status,
            priority: row.priority,
            assigned_to: row.assigned_to ?? undefined,
            has_due_date: true,
          });
        }

        // Commitments WITHOUT due date — show on created_at date (pending/active only)
        const noDueRows = db.prepare(
          "SELECT * FROM commitments WHERE when_due IS NULL AND status IN ('pending', 'active') AND created_at >= ? AND created_at < ?"
        ).all(rangeStart, rangeEnd) as any[];

        for (const row of noDueRows) {
          events.push({
            id: row.id,
            type: 'commitment',
            title: row.what,
            timestamp: row.created_at,
            status: row.status,
            priority: row.priority,
            assigned_to: row.assigned_to ?? undefined,
            has_due_date: false,
          });
        }

        // Content items with scheduled_at in range
        const contentRows = db.prepare(
          'SELECT * FROM content_items WHERE scheduled_at IS NOT NULL AND scheduled_at >= ? AND scheduled_at < ?'
        ).all(rangeStart, rangeEnd) as any[];

        for (const row of contentRows) {
          events.push({
            id: row.id,
            type: 'content',
            title: row.title,
            timestamp: row.scheduled_at,
            status: row.stage,
            content_type: row.content_type,
            stage: row.stage,
          });
        }

        // Sort by timestamp
        events.sort((a, b) => a.timestamp - b.timestamp);

        return json(events);
      },
    },

    // --- Agents ---
    '/api/agents': {
      GET: () => {
        return json(buildAgentSnapshots(ctx).agents);
      },
      POST: async (req: Request) => {
        try {
          const taskManager = ctx.agentService.getTaskManager();
          if (!taskManager) return error('Persistent agents are not available.', 503);

          const body = await req.json() as { specialist?: string; task?: string; context?: string };
          const deps = {
            orchestrator: ctx.agentService.getOrchestrator(),
            llmManager: ctx.agentService.getLLMManager(),
            specialists: ctx.agentService.getSpecialists(),
            taskManager,
          };

          const spawned = spawnPersistentAgent(deps, body.specialist ?? '');
          let assignment: Awaited<ReturnType<typeof assignPersistentAgentTask>> | null = null;

          if (body.task?.trim()) {
            assignment = await assignPersistentAgentTask(deps, {
              agentId: spawned.agent.id,
              task: body.task.trim(),
              context: body.context?.trim(),
            });
          }

          const latestTask = taskManager.getAgentTask(spawned.agent.id);
          return json({
            ...spawned.agent.toJSON(),
            busy: taskManager.isAgentBusy(spawned.agent.id),
            latest_task: latestTask ? {
              id: latestTask.id,
              status: latestTask.status,
              task: latestTask.task,
              started_at: latestTask.startedAt,
              completed_at: latestTask.completedAt,
            } : null,
            spawned: spawned.summary,
            assignment,
          }, 201);
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    '/api/agents/specialists': {
      GET: () => {
        const specialists = Array.from(ctx.agentService.getSpecialists().values()).map((role) => ({
          id: role.id,
          name: role.name,
          description: role.description,
          authority_level: role.authority_level,
          tools: role.tools,
        }));
        return json({ specialists });
      },
    },

    // Bun.serve matches literal paths (e.g. /api/agents/specialists) before patterns, so order is irrelevant.
    '/api/agents/:id': {
      DELETE: (req: Request & { params: { id: string } }) => {
        try {
          const taskManager = ctx.agentService.getTaskManager();
          if (!taskManager) return error('Persistent agents are not available.', 503);
          const deps = {
            orchestrator: ctx.agentService.getOrchestrator(),
            llmManager: ctx.agentService.getLLMManager(),
            specialists: ctx.agentService.getSpecialists(),
            taskManager,
          };
          return json(terminatePersistentAgent(deps, req.params.id));
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    '/api/agents/tree': {
      GET: () => {
        const orchestrator = ctx.agentService.getOrchestrator();
        const all = orchestrator.getAllAgents().map((a) => a.toJSON());
        // Build tree structure
        const primary = all.find((a) => !a.parent_id);
        const children = all.filter((a) => a.parent_id);
        return json({
          primary: primary ?? null,
          children,
        });
      },
    },

    '/api/agents/tasks': {
      GET: () => {
        const tm = ctx.agentService.getTaskManager();
        if (!tm) {
          return json({
            active_agents: 0,
            agents: [],
            tasks_total: 0,
            tasks_running: 0,
            tasks: [],
          });
        }
        return json(listPersistentAgents({
          orchestrator: ctx.agentService.getOrchestrator(),
          llmManager: ctx.agentService.getLLMManager(),
          specialists: ctx.agentService.getSpecialists(),
          taskManager: tm,
        }));
      },
    },

    // --- Personality ---
    '/api/personality': {
      GET: () => json(getPersonality()),
    },

    // --- User Profile Wizard ---
    '/api/user-profile': {
      GET: () => {
        const profile = getUserProfile();
        return json({
          questions: USER_PROFILE_QUESTIONS,
          profile,
          answered_count: countAnsweredUserProfileQuestions(profile),
          total_questions: USER_PROFILE_QUESTIONS.length,
          has_profile: hasUserProfile(profile),
        });
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as { answers?: Record<string, unknown> };
          const profile = saveUserProfile(body.answers ?? {});
          return json({
            ok: true,
            profile,
            answered_count: countAnsweredUserProfileQuestions(profile),
            total_questions: USER_PROFILE_QUESTIONS.length,
            message: 'User profile saved.',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(`Failed to save user profile: ${msg}`);
        }
      },
    },

    '/api/user-profile/clear': {
      POST: () => {
        clearUserProfile();
        return json({ ok: true, message: 'User profile cleared.' });
      },
    },

    // --- Config (sanitized — no API keys) ---
    '/api/config': {
      GET: () => {
        const config = ctx.config;
        return json({
          daemon: config.daemon,
          llm: {
            primary: config.llm.primary,
            fallback: config.llm.fallback,
            anthropic: config.llm.anthropic ? { model: config.llm.anthropic.model } : null,
            openai: config.llm.openai ? { model: config.llm.openai.model } : null,
            groq: config.llm.groq ? { model: config.llm.groq.model } : null,
            ollama: config.llm.ollama ?? null,
          },
          personality: config.personality,
          authority: config.authority,
          heartbeat: config.heartbeat,
          active_role: config.active_role,
        });
      },
    },

    '/api/system/autostart': {
      GET: () => {
        const installed = isAutostartInstalled();
        const keepaliveSupported = process.platform === 'darwin' || process.platform === 'linux';
        return json({
          platform: process.platform,
          manager: keepaliveSupported ? getAutostartName() : 'unsupported',
          installed,
          keepalive_supported: keepaliveSupported,
          restart_supported: keepaliveSupported && installed,
        });
      },
    },

    '/api/system/autostart/restart': {
      POST: () => {
        if (!(process.platform === 'darwin' || process.platform === 'linux')) {
          return error('24/7 restart is not supported on this platform.', 400);
        }
        if (!isAutostartInstalled()) {
          return error('JARVIS keepalive mode is not installed yet.', 400);
        }
        const scheduled = scheduleAutostartRestart();
        if (!scheduled) {
          return error('Failed to schedule keepalive service restart.');
        }
        return json({
          ok: true,
          message: `Restarting the JARVIS 24/7 ${getAutostartName()} service.`,
        });
      },
    },

    // --- LLM Configuration (DB + encrypted keychain) ---
    '/api/config/llm': {
      GET: async () => {
        const { getLLMSettings } = await import('./llm-settings.ts');
        return json(getLLMSettings(ctx.config));
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as Record<string, unknown>;
          const { saveLLMSettings, hotReloadLLMProviders } = await import('./llm-settings.ts');

          saveLLMSettings(ctx.config, body as any);

          // Hot-reload providers on the shared LLMManager
          const llmManager = ctx.agentService.getLLMManager();
          hotReloadLLMProviders(ctx.config, llmManager);

          return json({ ok: true, message: 'LLM configuration saved and applied.' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(`Failed to save LLM config: ${msg}`);
        }
      },
    },

    '/api/config/llm/test': {
      POST: async (req: Request) => {
        try {
          const body = await req.json() as { provider: string; api_key?: string; model?: string; base_url?: string };
          const { testLLMProvider } = await import('./llm-settings.ts');
          const result = await testLLMProvider(body, ctx.config);
          return json(result);
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    // --- Roles ---
    '/api/roles': {
      GET: () => {
        const orchestrator = ctx.agentService.getOrchestrator();
        const primary = orchestrator.getPrimary();
        return json({
          active_role: primary?.agent.role.name ?? ctx.config.active_role,
          // Note: specialist list is injected via prompt-builder, not directly accessible here
          // We'll return what we can from the agent's role
          role: primary?.agent.role ? {
            id: primary.agent.role.id,
            name: primary.agent.role.name,
            authority_level: primary.agent.role.authority_level,
            tools: primary.agent.role.tools,
            sub_roles: primary.agent.role.sub_roles,
          } : null,
        });
      },
    },

    // --- Content Pipeline ---
    '/api/content': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const stage = params.get('stage') as ContentStage | null;
        const content_type = params.get('type') as ContentType | null;
        const tag = params.get('tag');
        const query: { stage?: ContentStage; content_type?: ContentType; tag?: string } = {};
        if (stage) query.stage = stage;
        if (content_type) query.content_type = content_type;
        if (tag) query.tag = tag;
        return json(findContent(query));
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as {
            title: string;
            body?: string;
            content_type?: ContentType;
            stage?: ContentStage;
            tags?: string[];
            created_by?: string;
          };
          if (!body.title) return error('Missing "title" field');
          const item = createContent(body.title, {
            body: body.body,
            content_type: body.content_type,
            stage: body.stage,
            tags: body.tags,
            created_by: body.created_by,
          });
          ctx.wsService?.broadcastContentUpdate(item, 'created');
          return json(item, 201);
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    '/api/content/:id': {
      GET: (req: Request & { params: { id: string } }) => {
        const item = getContent(req.params.id);
        if (!item) return error('Content not found', 404);
        return json(item);
      },
      PATCH: async (req: Request & { params: { id: string } }) => {
        try {
          const body = await req.json() as {
            title?: string;
            body?: string;
            content_type?: ContentType;
            stage?: ContentStage;
            tags?: string[];
            scheduled_at?: number | null;
            published_at?: number | null;
            published_url?: string | null;
            sort_order?: number;
          };
          const updated = updateContent(req.params.id, body);
          if (!updated) return error('Content not found', 404);
          ctx.wsService?.broadcastContentUpdate(updated, 'updated');
          return json(updated);
        } catch (err) {
          return error('Invalid request body');
        }
      },
      DELETE: (req: Request & { params: { id: string } }) => {
        const existing = getContent(req.params.id);
        if (!existing) return error('Content not found', 404);
        deleteContent(req.params.id);
        ctx.wsService?.broadcastContentUpdate(existing, 'deleted');
        return json({ ok: true });
      },
    },

    '/api/content/:id/advance': {
      POST: (req: Request & { params: { id: string } }) => {
        const updated = advanceStage(req.params.id);
        if (!updated) return error('Cannot advance (not found or already at last stage)', 400);
        ctx.wsService?.broadcastContentUpdate(updated, 'updated');
        return json(updated);
      },
    },

    '/api/content/:id/regress': {
      POST: (req: Request & { params: { id: string } }) => {
        const updated = regressStage(req.params.id);
        if (!updated) return error('Cannot regress (not found or already at first stage)', 400);
        ctx.wsService?.broadcastContentUpdate(updated, 'updated');
        return json(updated);
      },
    },

    '/api/content/:id/notes': {
      GET: (req: Request & { params: { id: string } }) => {
        const params = getSearchParams(req);
        const stage = params.get('stage') as ContentStage | null;
        return json(getStageNotes(req.params.id, stage ?? undefined));
      },
      POST: async (req: Request & { params: { id: string } }) => {
        try {
          const body = await req.json() as {
            stage: ContentStage;
            note: string;
            author?: string;
          };
          if (!body.stage || !body.note) return error('Missing "stage" or "note" field');
          const note = addStageNote(req.params.id, body.stage, body.note, body.author);
          // Broadcast content update so UI refreshes
          const item = getContent(req.params.id);
          if (item) ctx.wsService?.broadcastContentUpdate(item, 'updated');
          return json(note, 201);
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    '/api/content/:id/attachments': {
      GET: (req: Request & { params: { id: string } }) => {
        return json(getAttachments(req.params.id));
      },
      POST: async (req: Request & { params: { id: string } }) => {
        try {
          const contentId = req.params.id;
          const item = getContent(contentId);
          if (!item) return error('Content not found', 404);

          const formData = await req.formData();
          const file = formData.get('file') as File | null;
          if (!file) return error('Missing "file" in form data');

          // Enforce upload size limit
          if (file.size > MAX_UPLOAD_SIZE) {
            return error(`File too large. Maximum size is ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`, 413);
          }

          // Block dangerous MIME types
          const mimeType = file.type || 'application/octet-stream';
          if (BLOCKED_MIME_TYPES.has(mimeType)) {
            return error(`File type "${mimeType}" is not allowed`, 415);
          }

          const label = (formData.get('label') as string) || null;

          // Sanitize filename to prevent path traversal
          const safeName = path.basename(file.name);
          if (!safeName || safeName === '.' || safeName === '..') {
            return error('Invalid filename', 400);
          }

          // Save file to ~/.jarvis/content/<id>/
          const baseDir = path.join(os.homedir(), '.jarvis', 'content', contentId);
          if (!existsSync(baseDir)) {
            mkdirSync(baseDir, { recursive: true });
          }

          const diskPath = path.resolve(baseDir, safeName);
          // Verify resolved path stays within the content directory
          if (!isWithinBase(diskPath, baseDir)) {
            return error('Invalid filename', 400);
          }

          await Bun.write(diskPath, file);

          const attachment = addAttachment(
            contentId,
            safeName,
            diskPath,
            mimeType,
            file.size,
            label ?? undefined,
          );

          ctx.wsService?.broadcastContentUpdate(item, 'updated');
          return json(attachment, 201);
        } catch (err) {
          return error('File upload failed');
        }
      },
    },

    '/api/content/:id/attachments/:aid': {
      DELETE: (req: Request & { params: { id: string; aid: string } }) => {
        // Verify attachment belongs to this content item before deleting
        const attachment = getAttachment(req.params.aid);
        if (!attachment || attachment.content_id !== req.params.id) {
          return error('Attachment not found', 404);
        }
        const deleted = deleteAttachment(req.params.aid);
        if (!deleted) return error('Attachment not found', 404);
        const item = getContent(req.params.id);
        if (item) ctx.wsService?.broadcastContentUpdate(item, 'updated');
        return json({ ok: true });
      },
    },

    '/api/content/files/:contentId/:filename': {
      GET: async (req: Request & { params: { contentId: string; filename: string } }) => {
        // Sanitize path segments to prevent traversal
        const safeContentId = sanitizePathSegment(req.params.contentId);
        const safeFilename = sanitizePathSegment(req.params.filename);
        if (!safeContentId || !safeFilename) {
          return error('Invalid path', 400);
        }

        const baseDir = path.join(os.homedir(), '.jarvis', 'content');
        const filePath = path.resolve(baseDir, safeContentId, safeFilename);

        // Verify resolved path stays within the content directory
        if (!isWithinBase(filePath, baseDir)) {
          return error('Invalid path', 400);
        }

        const file = Bun.file(filePath);
        if (!await file.exists()) {
          return error('File not found', 404);
        }

        return new Response(file, {
          headers: {
            ...CORS,
            'Content-Disposition': 'attachment',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      },
    },

    // --- Google OAuth Callback ---
    '/api/auth/google/callback': {
      GET: async (req: Request) => {
        const params = getSearchParams(req);
        const code = params.get('code');
        const authError = params.get('error');

        if (authError) {
          return new Response(
            `<html><body><h1>Authorization Denied</h1><p>${escapeHtml(authError)}</p><p>You can close this tab.</p></body></html>`,
            { headers: { ...CORS, 'Content-Type': 'text/html' } }
          );
        }

        if (!code) {
          return error('Missing authorization code', 400);
        }

        // Try to exchange the code using GoogleAuth from context
        const googleConfig = ctx.config.google;
        if (!googleConfig?.client_id || !googleConfig?.client_secret) {
          return error('Google OAuth not configured in config.yaml', 500);
        }

        try {
          // Lazy import to avoid circular deps
          const { GoogleAuth } = await import('../integrations/google-auth.ts');
          const auth = new GoogleAuth(googleConfig.client_id, googleConfig.client_secret);
          await auth.exchangeCode(code);

          return new Response(
            `<html><body style="font-family:system-ui;text-align:center;padding:60px">
              <h1>JARVIS Google Authorization Complete!</h1>
              <p>Tokens saved. This window will close automatically.</p>
              <script>
                if (window.opener) { window.opener.postMessage('google-auth-complete', window.location.origin); }
                setTimeout(function() { window.close(); }, 2000);
              </script>
            </body></html>`,
            { headers: { ...CORS, 'Content-Type': 'text/html' } }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(
            `<html><body><h1>Token Exchange Failed</h1><pre>${escapeHtml(msg)}</pre></body></html>`,
            { headers: { ...CORS, 'Content-Type': 'text/html' }, status: 500 }
          );
        }
      },
    },

    // --- Google Auth Management ---
    '/api/auth/google/status': {
      GET: async () => {
        const googleConfig = ctx.config.google;
        const hasCredentials = !!(googleConfig?.client_id && googleConfig?.client_secret);

        if (!hasCredentials) {
          return json({ status: 'not_configured', has_credentials: false, is_authenticated: false, scopes: [], token_expiry: null });
        }

        try {
          const { GoogleAuth } = await import('../integrations/google-auth.ts');
          const auth = new GoogleAuth(googleConfig!.client_id, googleConfig!.client_secret);
          const authenticated = auth.isAuthenticated();
          const tokens = auth.loadTokens();

          return json({
            status: authenticated ? 'connected' : 'credentials_saved',
            has_credentials: true,
            is_authenticated: authenticated,
            scopes: ['gmail.readonly', 'calendar.readonly'],
            token_expiry: tokens?.expiry_date ?? null,
          });
        } catch {
          return json({ status: 'credentials_saved', has_credentials: true, is_authenticated: false, scopes: [], token_expiry: null });
        }
      },
    },

    '/api/config/google': {
      POST: async (req: Request) => {
        try {
          const body = await req.json() as { client_id: string; client_secret: string };
          if (!body.client_id || !body.client_secret) {
            return error('Missing client_id or client_secret');
          }

          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();
          freshConfig.google = { client_id: body.client_id, client_secret: body.client_secret };
          await saveConfig(freshConfig);

          // Update in-memory config so callback route sees credentials immediately
          ctx.config.google = freshConfig.google;

          return json({ ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(`Failed to save Google config: ${msg}`, 500);
        }
      },
    },

    '/api/auth/google/init': {
      POST: async () => {
        const googleConfig = ctx.config.google;
        if (!googleConfig?.client_id || !googleConfig?.client_secret) {
          return error('Google credentials not configured. Save client_id and client_secret first.', 400);
        }

        try {
          const { GoogleAuth } = await import('../integrations/google-auth.ts');
          const auth = new GoogleAuth(googleConfig.client_id, googleConfig.client_secret);
          const scopes = [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/calendar.readonly',
          ];
          const authUrl = auth.getAuthUrl(scopes);
          return json({ auth_url: authUrl });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(`Failed to generate auth URL: ${msg}`, 500);
        }
      },
    },

    '/api/auth/google/disconnect': {
      POST: async () => {
        try {
          const tokensPath = path.join(os.homedir(), '.jarvis', 'google-tokens.json');
          if (existsSync(tokensPath)) {
            const { unlinkSync } = await import('node:fs');
            unlinkSync(tokensPath);
          }
          return json({ ok: true, message: 'Disconnected. Restart JARVIS to deactivate observers.' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(`Failed to disconnect: ${msg}`, 500);
        }
      },
    },

    // --- Channels ---
    '/api/channels/status': {
      GET: () => {
        if (!ctx.channelService) return json({ channels: {}, stt: null });
        return json({
          channels: ctx.channelService.getChannelStatus(),
          stt: ctx.config.stt?.provider ?? null,
        });
      },
    },

    '/api/config/channels': {
      GET: () => {
        const cfg = ctx.config.channels;
        return json({
          telegram: cfg?.telegram ? {
            enabled: cfg.telegram.enabled,
            has_token: !!cfg.telegram.bot_token,
            allowed_users: cfg.telegram.allowed_users,
          } : { enabled: false, has_token: false, allowed_users: [] },
          discord: cfg?.discord ? {
            enabled: cfg.discord.enabled,
            has_token: !!cfg.discord.bot_token,
            allowed_users: cfg.discord.allowed_users,
            guild_id: cfg.discord.guild_id ?? null,
          } : { enabled: false, has_token: false, allowed_users: [], guild_id: null },
        });
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as Record<string, unknown>;
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();

          if (!freshConfig.channels) freshConfig.channels = {};

          if (body.telegram && typeof body.telegram === 'object') {
            freshConfig.channels.telegram = {
              ...freshConfig.channels.telegram,
              ...(body.telegram as Record<string, unknown>),
            } as any;
          }
          if (body.discord && typeof body.discord === 'object') {
            freshConfig.channels.discord = {
              ...freshConfig.channels.discord,
              ...(body.discord as Record<string, unknown>),
            } as any;
          }

          await saveConfig(freshConfig);
          ctx.config.channels = freshConfig.channels;

          return json({ ok: true, message: 'Channel config saved. Restart JARVIS to apply changes.' });
        } catch (err) {
          console.error('[API] Error saving channels config:', err);
          return error('Invalid request body');
        }
      },
    },

    '/api/config/stt': {
      GET: () => {
        const stt = ctx.config.stt;
        return json({
          provider: stt?.provider ?? 'openai',
          has_openai_key: !!stt?.openai?.api_key,
          has_groq_key: !!stt?.groq?.api_key,
          has_sarvam_key: !!stt?.sarvam?.api_key,
          local_endpoint: stt?.local?.endpoint ?? null,
          local_server_type: stt?.local?.server_type ?? 'whisper_cpp',
        });
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as Record<string, unknown>;
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();

          if (!freshConfig.stt) freshConfig.stt = {} as any;
          const stt = freshConfig.stt!;

          // Preserve keys for each provider if not provided in the update
          const providers = ['openai', 'groq', 'sarvam'] as const;
          for (const p of providers) {
            const incoming = body[p] as Record<string, unknown> | undefined;
            const existing = stt[p];
            if (incoming) {
              stt[p] = {
                ...existing,
                ...incoming,
                api_key: (incoming.api_key as string) || (existing as any)?.api_key || '',
              } as any;
              delete body[p];
            }
          }

          freshConfig.stt = { ...stt, ...body } as any;
          await saveConfig(freshConfig);
          ctx.config.stt = freshConfig.stt;
          return json({ ok: true, message: 'STT config saved. Restart JARVIS to apply changes.' });
        } catch (err) {
          console.error('[API] Error saving STT config:', err);
          return error('Invalid request body');
        }
      },
    },

    '/api/config/tts': {
      GET: () => {
        const tts = ctx.config.tts;
        return json({
          enabled: tts?.enabled ?? false,
          provider: tts?.provider ?? 'edge',
          voice: tts?.voice ?? 'en-US-AriaNeural',
          rate: tts?.rate ?? '+0%',
          volume: tts?.volume ?? '+0%',
          elevenlabs: tts?.elevenlabs ? {
            has_api_key: !!tts.elevenlabs.api_key,
            voice_id: tts.elevenlabs.voice_id ?? null,
            model: tts.elevenlabs.model ?? 'eleven_flash_v2_5',
            stability: tts.elevenlabs.stability ?? 0.5,
            similarity_boost: tts.elevenlabs.similarity_boost ?? 0.75,
          } : null,
          sarvam: tts?.sarvam ? {
            has_api_key: !!tts.sarvam.api_key,
            model: tts.sarvam.model ?? 'bulbul:v3',
            language: tts.sarvam.language ?? 'en-IN',
            speaker: tts.sarvam.speaker ?? 'anushka',
            sampling_rate: tts.sarvam.sampling_rate ?? 48000,
          } : null,
        });
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as Record<string, unknown>;
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();

          if (!freshConfig.tts) freshConfig.tts = {} as any;

          // Deep-merge elevenlabs sub-object to preserve API key across saves
          const incomingEl = body.elevenlabs as Record<string, unknown> | undefined;
          const existingEl = freshConfig.tts?.elevenlabs;
          delete body.elevenlabs;

          freshConfig.tts = { ...freshConfig.tts, ...body } as any;

          if (incomingEl) {
            freshConfig.tts!.elevenlabs = {
              ...existingEl,
              ...incomingEl,
              // Keep existing API key if new one not provided
              api_key: (incomingEl.api_key as string) || existingEl?.api_key || '',
            } as any;
          }

          const incomingSarvam = body.sarvam as Record<string, unknown> | undefined;
          const existingSarvam = freshConfig.tts?.sarvam;
          delete body.sarvam;

          if (incomingSarvam) {
            freshConfig.tts!.sarvam = {
              ...existingSarvam,
              ...incomingSarvam,
              // Keep existing API key if new one not provided
              api_key: (incomingSarvam.api_key as string) || existingSarvam?.api_key || '',
            } as any;
          }

          await saveConfig(freshConfig);
          ctx.config.tts = freshConfig.tts;

          // Hot-reload TTS provider if wsService available
          if (ctx.wsService && freshConfig.tts) {
            const { createTTSProvider } = await import('../comms/voice.ts');
            const provider = createTTSProvider(freshConfig.tts);
            if (provider) {
              ctx.wsService.setTTSProvider(provider);
            }
          }

          return json({ ok: true, message: 'TTS config saved.' });
        } catch (err) {
          console.error('[API] Error saving TTS config:', err);
          return error('Invalid request body');
        }
      },
    },

    // --- TTS Voices ---
    '/api/tts/voices': {
      GET: async (req: Request) => {
        const params = getSearchParams(req);
        const provider = params.get('provider') ?? 'edge';

        if (provider === 'elevenlabs') {
          const apiKey = ctx.config.tts?.elevenlabs?.api_key;
          if (!apiKey) return error('ElevenLabs API key not configured', 400);

          try {
            const { listElevenLabsVoices } = await import('../comms/voice.ts');
            const voices = await listElevenLabsVoices(apiKey);
            return json(voices);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return error(`Failed to fetch ElevenLabs voices: ${msg}`, 500);
          }
        }

        // Edge TTS: return hardcoded voice list
        return json([
          { voice_id: 'en-US-AriaNeural', name: 'Aria (US Female)', category: 'neural' },
          { voice_id: 'en-US-GuyNeural', name: 'Guy (US Male)', category: 'neural' },
          { voice_id: 'en-GB-SoniaNeural', name: 'Sonia (UK Female)', category: 'neural' },
          { voice_id: 'en-AU-NatashaNeural', name: 'Natasha (AU Female)', category: 'neural' },
          { voice_id: 'en-US-JennyNeural', name: 'Jenny (US Female)', category: 'neural' },
          { voice_id: 'en-US-DavisNeural', name: 'Davis (US Male)', category: 'neural' },
        ]);
      },
    },

    // --- Authority & Autonomy ---
    '/api/authority/status': {
      GET: () => {
        const engine = ctx.authorityEngine;
        const emergency = ctx.emergencyController;
        const approvals = ctx.approvalManager;
        if (!engine || !emergency) return json({ enabled: false });

        return json({
          enabled: true,
          emergency_state: emergency.getState(),
          pending_approvals: approvals?.getPending().length ?? 0,
          config: engine.getConfig(),
        });
      },
    },

    '/api/authority/approvals': {
      GET: (req: Request) => {
        if (!ctx.approvalManager) return json([]);
        const params = getSearchParams(req);
        const status = params.get('status');
        if (status === 'pending') {
          return json(ctx.approvalManager.getPending());
        }
        return json(ctx.approvalManager.getHistory({
          limit: parseInt(params.get('limit') ?? '50') || 50,
          action: (params.get('action') as ActionCategory) || undefined,
          agentId: params.get('agent_id') || undefined,
          status: (params.get('status') as any) || undefined,
        }));
      },
    },

    '/api/authority/approvals/:id/approve': {
      POST: async (req: Request & { params: { id: string } }) => {
        if (!ctx.approvalManager || !ctx.deferredExecutor) {
          return error('Authority system not configured', 500);
        }
        const requestId = req.params.id;
        const approved = ctx.approvalManager.approve(requestId, 'dashboard');
        if (!approved) return error('Request not found or already decided', 404);

        // Execute the approved tool
        const result = await ctx.deferredExecutor.executeApproved(requestId);

        // Broadcast the update
        const updated = ctx.approvalManager.getRequest(requestId);
        if (updated) ctx.wsService?.broadcastApprovalUpdate(updated);

        return json({ ok: true, result: result.slice(0, 500) });
      },
    },

    '/api/authority/approvals/:id/deny': {
      POST: async (req: Request & { params: { id: string } }) => {
        if (!ctx.approvalManager || !ctx.deferredExecutor) {
          return error('Authority system not configured', 500);
        }
        const requestId = req.params.id;
        const denied = ctx.approvalManager.deny(requestId, 'dashboard');
        if (!denied) return error('Request not found or already decided', 404);

        // Record denial for learning
        ctx.deferredExecutor.recordDenial(denied);

        // Broadcast the update
        ctx.wsService?.broadcastApprovalUpdate(denied);

        return json({ ok: true });
      },
    },

    '/api/authority/audit': {
      GET: (req: Request) => {
        if (!ctx.auditTrail) return json([]);
        const params = getSearchParams(req);
        return json(ctx.auditTrail.query({
          agentId: params.get('agent_id') || undefined,
          action: (params.get('action') as ActionCategory) || undefined,
          tool: params.get('tool') || undefined,
          decision: (params.get('decision') as AuthorityDecisionType) || undefined,
          since: params.get('since') ? parseInt(params.get('since')!) : undefined,
          limit: parseInt(params.get('limit') ?? '100') || 100,
        }));
      },
    },

    '/api/authority/audit/stats': {
      GET: (req: Request) => {
        if (!ctx.auditTrail) return json({ total: 0, allowed: 0, denied: 0, approvalRequired: 0, byCategory: {} });
        const params = getSearchParams(req);
        const since = params.get('since') ? parseInt(params.get('since')!) : undefined;
        return json(ctx.auditTrail.getStats(since));
      },
    },

    '/api/authority/emergency/pause': {
      POST: () => {
        if (!ctx.emergencyController) return error('Emergency controller not configured', 500);
        ctx.emergencyController.pause();
        return json({ ok: true, state: ctx.emergencyController.getState() });
      },
    },

    '/api/authority/emergency/resume': {
      POST: () => {
        if (!ctx.emergencyController) return error('Emergency controller not configured', 500);
        ctx.emergencyController.resume();
        return json({ ok: true, state: ctx.emergencyController.getState() });
      },
    },

    '/api/authority/emergency/kill': {
      POST: () => {
        if (!ctx.emergencyController) return error('Emergency controller not configured', 500);
        ctx.emergencyController.kill();
        return json({ ok: true, state: ctx.emergencyController.getState() });
      },
    },

    '/api/authority/emergency/reset': {
      POST: () => {
        if (!ctx.emergencyController) return error('Emergency controller not configured', 500);
        ctx.emergencyController.reset();
        return json({ ok: true, state: ctx.emergencyController.getState() });
      },
    },

    '/api/authority/config': {
      GET: () => {
        if (!ctx.authorityEngine) return json({});
        return json(ctx.authorityEngine.getConfig());
      },
      POST: async (req: Request) => {
        if (!ctx.authorityEngine) return error('Authority engine not configured', 500);
        try {
          const body = await req.json() as Record<string, unknown>;
          const currentConfig = ctx.authorityEngine.getConfig();

          // Merge updates into current config
          if (body.governed_categories) currentConfig.governed_categories = body.governed_categories as ActionCategory[];
          if (body.default_level !== undefined) currentConfig.default_level = body.default_level as number;
          if (body.overrides) currentConfig.overrides = body.overrides as any[];
          if (body.context_rules) currentConfig.context_rules = body.context_rules as any[];
          if (body.learning) currentConfig.learning = { ...currentConfig.learning, ...body.learning as any };

          ctx.authorityEngine.updateConfig(currentConfig);

          // Persist to config.yaml
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();
          freshConfig.authority = {
            ...freshConfig.authority,
            default_level: currentConfig.default_level,
            governed_categories: currentConfig.governed_categories,
            overrides: currentConfig.overrides,
            context_rules: currentConfig.context_rules,
            learning: currentConfig.learning,
          };
          await saveConfig(freshConfig);

          return json({ ok: true, config: currentConfig });
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    '/api/authority/learning/suggestions': {
      GET: () => {
        if (!ctx.learner) return json([]);
        return json(ctx.learner.getSuggestions());
      },
    },

    '/api/authority/learning/accept': {
      POST: async (req: Request) => {
        if (!ctx.learner || !ctx.authorityEngine) {
          return error('Learning system not configured', 500);
        }
        try {
          const body = await req.json() as { action: ActionCategory; tool_name: string };
          if (!body.action) return error('Missing "action" field');

          // Add the override to the engine
          ctx.authorityEngine.addOverride({
            action: body.action,
            allowed: true,
            requires_approval: false,
          });

          // Mark suggestion as sent
          ctx.learner.markSuggestionSent(body.action, body.tool_name ?? '');

          // Persist
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();
          freshConfig.authority = {
            ...freshConfig.authority,
            ...ctx.authorityEngine.getConfig(),
          };
          await saveConfig(freshConfig);

          return json({ ok: true });
        } catch (err) {
          return error('Invalid request body');
        }
      },
    },

    '/api/authority/learning/dismiss': {
      POST: async (req: Request) => {
        if (!ctx.learner) return error('Learning system not configured', 500);
        try {
          const body = await req.json() as { action: ActionCategory; tool_name: string };
          if (!body.action) return error('Missing "action" field');
          ctx.learner.resetPattern(body.action, body.tool_name ?? '');
          return json({ ok: true });
        } catch (err) { return error('Invalid request body'); }
      },
    },

    // --- Awareness (M13) ---
    '/api/awareness/status': {
      GET: () => {
        if (!ctx.awarenessService) return error('Awareness service not running', 503);
        return json({
          status: ctx.awarenessService.status(),
          enabled: ctx.awarenessService.isEnabled(),
          liveContext: ctx.awarenessService.getLiveContext(),
          usageEstimate: ctx.awarenessService.getUsageEstimate(),
        });
      },
    },

    '/api/awareness/context': {
      GET: () => {
        if (!ctx.awarenessService) return error('Awareness service not running', 503);
        return json(ctx.awarenessService.getLiveContext());
      },
    },

    '/api/awareness/captures': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const limit = parseInt(params.get('limit') ?? '50', 10);
        const app = params.get('app') ?? undefined;
        return json(getRecentCaptures(limit, app));
      },
    },

    '/api/awareness/captures/:id': {
      GET: (req: Request & { params: { id: string } }) => {
        const capture = getCapture(req.params.id);
        if (!capture) return error('Capture not found', 404);
        return json(capture);
      },
    },

    '/api/awareness/captures/:id/image': {
      GET: (req: Request & { params: { id: string } }) => {
        const capture = getCapture(req.params.id);
        if (!capture || !capture.image_path) return error('Image not found', 404);
        // Validate path stays within the expected captures/data directory
        const jarvisDir = path.join(os.homedir(), '.jarvis');
        if (!isWithinBase(capture.image_path, jarvisDir)) {
          return error('Image not found', 404);
        }
        try {
          const imageData = readFileSync(capture.image_path);
          return new Response(imageData, {
            headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
          });
        } catch {
          return error('Image file not found on disk', 404);
        }
      },
    },

    '/api/awareness/captures/:id/thumbnail': {
      GET: (req: Request & { params: { id: string } }) => {
        const capture = getCapture(req.params.id);
        if (!capture) return error('Capture not found', 404);
        const jarvisDir = path.join(os.homedir(), '.jarvis');
        // Prefer thumbnail, fall back to full image
        if (capture.thumbnail_path && isWithinBase(capture.thumbnail_path, jarvisDir)) {
          try {
            const thumbData = readFileSync(capture.thumbnail_path);
            return new Response(thumbData, {
              headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' },
            });
          } catch { /* thumbnail file missing, fall through */ }
        }
        if (capture.image_path && isWithinBase(capture.image_path, jarvisDir)) {
          try {
            const imageData = readFileSync(capture.image_path);
            return new Response(imageData, {
              headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
            });
          } catch { /* fall through */ }
        }
        return error('Thumbnail not found', 404);
      },
    },

    '/api/awareness/sessions': {
      GET: (req: Request) => {
        if (!ctx.awarenessService) return error('Awareness service not running', 503);
        const params = getSearchParams(req);
        const limit = parseInt(params.get('limit') ?? '20', 10);
        return json(ctx.awarenessService.getSessionHistory(limit));
      },
    },

    '/api/awareness/suggestions': {
      GET: (req: Request) => {
        if (!ctx.awarenessService) return error('Awareness service not running', 503);
        const params = getSearchParams(req);
        const limit = parseInt(params.get('limit') ?? '20', 10);
        const type = params.get('type') as SuggestionType | null;
        return json(ctx.awarenessService.getRecentSuggestionsList(limit, type ?? undefined));
      },
    },

    '/api/awareness/suggestions/:id/dismiss': {
      PATCH: (req: Request & { params: { id: string } }) => {
        if (!ctx.awarenessService) return error('Awareness service not running', 503);
        ctx.awarenessService.dismissSuggestion(req.params.id);
        return json({ ok: true });
      },
    },

    '/api/awareness/suggestions/:id/act': {
      PATCH: (req: Request & { params: { id: string } }) => {
        if (!ctx.awarenessService) return error('Awareness service not running', 503);
        ctx.awarenessService.actOnSuggestion(req.params.id);
        return json({ ok: true });
      },
    },

    '/api/awareness/report': {
      GET: async (req: Request) => {
        if (!ctx.awarenessService) return error('Awareness service not running', 503);
        const params = getSearchParams(req);
        const date = params.get('date') ?? undefined;
        try {
          const report = await ctx.awarenessService.generateReport(date);
          return json(report);
        } catch (err) {
          return error(`Report generation failed: ${err instanceof Error ? err.message : err}`, 500);
        }
      },
    },

    '/api/awareness/stats': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const start = parseInt(params.get('start') ?? String(Date.now() - 24 * 60 * 60 * 1000), 10);
        const end = parseInt(params.get('end') ?? String(Date.now()), 10);
        return json(getCapturesInRange(start, end));
      },
    },

    '/api/awareness/report/weekly': {
      GET: async (req: Request) => {
        if (!ctx.awarenessService) return error('Awareness service not available', 503);
        try {
          const params = getSearchParams(req);
          const weekStart = params.get('weekStart') ?? undefined;
          const report = await ctx.awarenessService.generateWeeklyReport(weekStart);
          return json(report);
        } catch (err) {
          return error(`Weekly report error: ${err instanceof Error ? err.message : err}`);
        }
      },
    },

    '/api/awareness/insights': {
      GET: (req: Request) => {
        if (!ctx.awarenessService) return error('Awareness service not available', 503);
        try {
          const params = getSearchParams(req);
          const days = parseInt(params.get('days') ?? '7', 10) || 7;
          const insights = ctx.awarenessService.getBehavioralInsights(days);
          return json(insights);
        } catch (err) {
          return error(`Insights error: ${err instanceof Error ? err.message : err}`);
        }
      },
    },

    '/api/awareness/toggle': {
      POST: async (req: Request) => {
        if (!ctx.awarenessService) return error('Awareness service not available', 503);
        try {
          const body = await req.json() as { enabled: boolean };
          ctx.awarenessService.toggle(body.enabled);
          return json({ ok: true, enabled: body.enabled });
        } catch {
          return error('Invalid request body');
        }
      },
    },

    // --- Workflows (M14) ---
    '/api/workflows': {
      GET: (req: Request) => {
        try {
          const { findWorkflows } = require('../vault/workflows.ts');
          const params = getSearchParams(req);
          const query: any = {};
          if (params.has('enabled')) query.enabled = params.get('enabled') === 'true';
          if (params.has('tag')) query.tag = params.get('tag');
          if (params.has('limit')) query.limit = parseInt(params.get('limit')!);
          return json(findWorkflows(query));
        } catch (err) { return error(`${err}`); }
      },
      POST: async (req: Request) => {
        try {
          const { createWorkflow, createVersion } = require('../vault/workflows.ts');
          const body = await req.json() as any;
          if (!body.name) return error('name is required');
          const wf = createWorkflow(body.name, {
            description: body.description,
            authority_level: body.authority_level,
            tags: body.tags,
          });
          if (body.definition) {
            createVersion(wf.id, body.definition, body.changelog ?? 'Initial version');
          }
          return json(wf, 201);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/nodes': {
      GET: () => {
        if (!ctx.nodeRegistry) return error('Node registry not available', 503);
        return json(ctx.nodeRegistry.list().map(n => ({
          type: n.type, label: n.label, description: n.description,
          category: n.category, icon: n.icon, color: n.color,
          configSchema: n.configSchema, inputs: n.inputs, outputs: n.outputs,
        })));
      },
    },

    '/api/workflows/import': {
      POST: async (req: Request) => {
        try {
          const { importWorkflowYaml } = require('../workflows/yaml.ts');
          const { createWorkflow, createVersion, setVariable } = require('../vault/workflows.ts');
          const yamlText = await req.text();
          const imported = importWorkflowYaml(yamlText);
          const wf = createWorkflow(imported.name, {
            description: imported.description,
            authority_level: imported.authority_level,
            tags: imported.tags,
          });
          createVersion(wf.id, imported.definition, 'Imported');
          for (const [k, v] of Object.entries(imported.variables)) {
            setVariable(wf.id, k, v);
          }
          return json(wf, 201);
        } catch (err) { return error(`YAML import failed: ${err}`); }
      },
    },

    '/api/workflows/:id': {
      GET: (req: Request) => {
        try {
          const { getWorkflow } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          const wf = getWorkflow(id);
          if (!wf) return error('Workflow not found', 404);
          return json(wf);
        } catch (err) { return error(`${err}`); }
      },
      PATCH: async (req: Request) => {
        try {
          const { updateWorkflow } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          const body = await req.json() as any;
          const updated = updateWorkflow(id, body);
          if (!updated) return error('Workflow not found', 404);
          return json(updated);
        } catch (err) { return error(`${err}`); }
      },
      DELETE: (req: Request) => {
        try {
          const { deleteWorkflow } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          ctx.triggerManager?.unregisterWorkflow(id);
          deleteWorkflow(id);
          return json({ ok: true });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/:id/versions': {
      GET: (req: Request) => {
        try {
          const { getVersionHistory } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2];
          return json(getVersionHistory(id));
        } catch (err) { return error(`${err}`); }
      },
      POST: async (req: Request) => {
        try {
          const { createVersion } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2];
          const body = await req.json() as any;
          if (!body.definition) return error('definition is required');
          const version = createVersion(id, body.definition, body.changelog);
          return json(version, 201);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/:id/execute': {
      POST: async (req: Request) => {
        if (!ctx.workflowEngine) return error('Workflow engine not available', 503);
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2];
          let triggerData: Record<string, unknown> = {};
          try { triggerData = await req.json() as any; } catch {}
          const execution = await ctx.workflowEngine.execute(id!, 'manual', triggerData);
          return json(execution, 201);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/:id/executions': {
      GET: (req: Request) => {
        try {
          const { findExecutions } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2];
          return json(findExecutions({ workflow_id: id }));
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/:id/variables': {
      GET: (req: Request) => {
        try {
          const { getVariables } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2];
          return json(getVariables(id));
        } catch (err) { return error(`${err}`); }
      },
      PATCH: async (req: Request) => {
        try {
          const { setVariable, getVariables } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2];
          const body = await req.json() as Record<string, unknown>;
          for (const [key, value] of Object.entries(body)) {
            setVariable(id, key, value);
          }
          return json(getVariables(id));
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/:id/export': {
      GET: (req: Request) => {
        try {
          const { getWorkflow, getLatestVersion, getVariables } = require('../vault/workflows.ts');
          const { exportWorkflowYaml } = require('../workflows/yaml.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2];
          const wf = getWorkflow(id);
          if (!wf) return error('Workflow not found', 404);
          const version = getLatestVersion(id);
          if (!version) return error('No version found', 404);
          const vars = getVariables(id);
          const yaml = exportWorkflowYaml(wf, version, vars);
          return new Response(yaml, {
            headers: {
              'Content-Type': 'text/yaml',
              'Content-Disposition': `attachment; filename="${sanitizeFilename(wf.name)}.yaml"`,
              ...CORS,
            },
          });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/executions/:executionId': {
      GET: (req: Request) => {
        try {
          const { getExecution, getStepResults } = require('../vault/workflows.ts');
          const url = new URL(req.url);
          const executionId = url.pathname.split('/').pop()!;
          const exec = getExecution(executionId);
          if (!exec) return error('Execution not found', 404);
          const steps = getStepResults(executionId);
          return json({ ...exec, steps });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/executions/:executionId/cancel': {
      POST: async (req: Request) => {
        if (!ctx.workflowEngine) return error('Workflow engine not available', 503);
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const executionId = parts[parts.length - 2];
          await ctx.workflowEngine.cancel(executionId!);
          return json({ ok: true });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/nl-chat': {
      POST: async (req: Request) => {
        if (!ctx.nlBuilder) return error('NL builder not available', 503);
        try {
          const body = await req.json() as { workflowId: string; message: string; history?: Array<{ role: string; content: string }> };
          const result = await ctx.nlBuilder.chat(
            body.workflowId,
            body.message,
            (body.history ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>,
          );
          return json(result);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/suggest': {
      GET: async () => {
        if (!ctx.autoSuggest) return error('Auto-suggest not available', 503);
        try {
          const suggestions = await ctx.autoSuggest.generateSuggestions();
          return json(suggestions);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/workflows/suggest/:id/dismiss': {
      POST: async (req: Request) => {
        if (!ctx.autoSuggest) return error('Auto-suggest not available', 503);
        try {
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop() === 'dismiss'
            ? url.pathname.split('/').slice(-2, -1)[0]
            : url.pathname.split('/').pop()!;
          ctx.autoSuggest.dismiss(id!);
          return json({ ok: true });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/webhooks/:id': {
      POST: async (req: Request) => {
        if (!ctx.webhookManager) return error('Webhook manager not available', 503);
        try {
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          return ctx.webhookManager.handleRequest(id, req);
        } catch (err) { return error(`${err}`); }
      },
      GET: async (req: Request) => {
        if (!ctx.webhookManager) return error('Webhook manager not available', 503);
        try {
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          return ctx.webhookManager.handleRequest(id, req);
        } catch (err) { return error(`${err}`); }
      },
    },

    // ── Goals (M16) ─────────────────────────────────────────────────

    '/api/goals': {
      GET: (req: Request) => {
        try {
          const url = new URL(req.url);
          const status = url.searchParams.get('status') ?? undefined;
          const level = url.searchParams.get('level') ?? undefined;
          const tag = url.searchParams.get('tag') ?? undefined;
          const health = url.searchParams.get('health') ?? undefined;
          const parent_id = url.searchParams.get('parent_id');
          const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
          const goals = require('../vault/goals.ts');
          return json(goals.findGoals({
            status: status as any,
            level: level as any,
            tag,
            health: health as any,
            parent_id: parent_id === 'null' ? null : parent_id ?? undefined,
            limit,
          }));
        } catch (err) { return error(`${err}`); }
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as Record<string, unknown>;
          const mode = body.mode as string | undefined;

          // Natural language → OKR proposal (uses LLM)
          if (mode === 'propose') {
            const text = body.text as string;
            if (!text?.trim()) return error('text is required for propose mode', 400);
            const { NLGoalBuilder } = await import('../goals/nl-builder.ts');
            const llmManager = ctx.agentService.getLLMManager();
            const builder = new NLGoalBuilder(llmManager);
            const proposal = await builder.parseGoal(text.trim());
            return json(proposal);
          }

          // Create goals from a confirmed proposal
          if (mode === 'create_from_proposal') {
            const proposal = body.proposal as any;
            if (!proposal?.objective?.title) return error('proposal with objective required', 400);
            const { NLGoalBuilder } = await import('../goals/nl-builder.ts');
            const llmManager = ctx.agentService.getLLMManager();
            const builder = new NLGoalBuilder(llmManager);
            const created = builder.createFromProposal(proposal, body.parent_id as string | undefined);
            return json(created, 201);
          }

          // Quick create (direct)
          const title = body.title as string;
          const level = (body.level as string) ?? 'task';
          if (!title) return error('title is required', 400);
          const goals = require('../vault/goals.ts');
          const goal = goals.createGoal(title, level, body);
          return json(goal, 201);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/roots': {
      GET: () => {
        try {
          const goals = require('../vault/goals.ts');
          return json(goals.getRootGoals());
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/overdue': {
      GET: () => {
        try {
          const goals = require('../vault/goals.ts');
          return json(goals.getOverdueGoals());
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/metrics': {
      GET: () => {
        try {
          const goals = require('../vault/goals.ts');
          return json(goals.getGoalMetrics());
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/reorder': {
      POST: async (req: Request) => {
        try {
          const body = await req.json() as { id: string; sort_order: number }[];
          const goals = require('../vault/goals.ts');
          goals.reorderGoals(body);
          return json({ ok: true });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/check-ins': {
      GET: (req: Request) => {
        try {
          const url = new URL(req.url);
          const type = url.searchParams.get('type') as any;
          const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
          const goals = require('../vault/goals.ts');
          return json(goals.getRecentCheckIns(type ?? undefined, limit));
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/daily-actions': {
      GET: () => {
        try {
          const goals = require('../vault/goals.ts');
          return json(goals.findGoals({ level: 'daily_action', status: 'active', limit: 20 }));
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/:id': {
      GET: (req: Request) => {
        try {
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          const goals = require('../vault/goals.ts');
          const goal = goals.getGoal(id);
          if (!goal) return error('Goal not found', 404);
          return json(goal);
        } catch (err) { return error(`${err}`); }
      },
      PATCH: async (req: Request) => {
        try {
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          const body = await req.json() as Record<string, unknown>;
          const goals = require('../vault/goals.ts');
          const updated = goals.updateGoal(id, body);
          if (!updated) return error('Goal not found', 404);
          return json(updated);
        } catch (err) { return error(`${err}`); }
      },
      DELETE: (req: Request) => {
        try {
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          const goals = require('../vault/goals.ts');
          const deleted = goals.deleteGoal(id);
          if (!deleted) return error('Goal not found', 404);
          return json({ ok: true });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/:id/tree': {
      GET: (req: Request) => {
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          const goals = require('../vault/goals.ts');
          return json(goals.getGoalTree(id));
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/:id/children': {
      GET: (req: Request) => {
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          const goals = require('../vault/goals.ts');
          return json(goals.getGoalChildren(id));
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/:id/score': {
      POST: async (req: Request) => {
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          const body = await req.json() as { score: number; reason: string; source?: string };
          const goals = require('../vault/goals.ts');
          const updated = goals.updateGoalScore(id, body.score, body.reason, body.source ?? 'user');
          if (!updated) return error('Goal not found', 404);
          return json(updated);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/:id/status': {
      POST: async (req: Request) => {
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          const body = await req.json() as { status: string };
          const goals = require('../vault/goals.ts');
          const updated = goals.updateGoalStatus(id, body.status as any);
          if (!updated) return error('Goal not found', 404);
          return json(updated);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/:id/health': {
      POST: async (req: Request) => {
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          const body = await req.json() as { health: string };
          const goals = require('../vault/goals.ts');
          const updated = goals.updateGoalHealth(id, body.health as any);
          if (!updated) return error('Goal not found', 404);
          return json(updated);
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/goals/:id/progress': {
      GET: (req: Request) => {
        try {
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
          const goals = require('../vault/goals.ts');
          return json(goals.getProgressHistory(id, limit));
        } catch (err) { return error(`${err}`); }
      },
    },

    // --- Documents ---
    '/api/documents': {
      GET: (req: Request) => {
        try {
          const { findDocuments } = require('../vault/documents.ts');
          const url = new URL(req.url);
          const format = url.searchParams.get('format') || undefined;
          const tag = url.searchParams.get('tag') || undefined;
          const search = url.searchParams.get('search') || undefined;
          const query = (format || tag || search) ? { format, tag, search } : undefined;
          return json(findDocuments(query));
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/documents/:id': {
      GET: (req: Request) => {
        try {
          const { getDocument } = require('../vault/documents.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 1]!;
          const doc = getDocument(id);
          if (!doc) return error('Document not found', 404);
          return json(doc);
        } catch (err) { return error(`${err}`); }
      },
      DELETE: (req: Request) => {
        try {
          const { deleteDocument } = require('../vault/documents.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 1]!;
          const deleted = deleteDocument(id);
          if (!deleted) return error('Document not found', 404);
          return json({ ok: true });
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/documents/:id/download': {
      GET: (req: Request) => {
        try {
          const { getDocument } = require('../vault/documents.ts');
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          const doc = getDocument(id);
          if (!doc) return error('Document not found', 404);

          const ext: Record<string, string> = {
            markdown: '.md', plain: '.txt', html: '.html',
            json: '.json', csv: '.csv', code: '.txt',
          };
          // Serve all formats as safe MIME types to prevent XSS via inline rendering
          const mime: Record<string, string> = {
            markdown: 'text/markdown', plain: 'text/plain', html: 'text/plain',
            json: 'application/json', csv: 'text/csv', code: 'text/plain',
          };

          const filename = doc.title.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_') + (ext[doc.format] || '.txt');

          return new Response(doc.body, {
            headers: {
              'Content-Type': mime[doc.format] || 'text/plain',
              'Content-Disposition': `attachment; filename="${filename}"`,
              'X-Content-Type-Options': 'nosniff',
            },
          });
        } catch (err) { return error(`${err}`); }
      },
    },

    // --- Sidecars ---
    '/api/sidecars': {
      GET: () => {
        try {
          if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);
          return json(ctx.sidecarManager.listSidecars());
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/sidecars/enroll': {
      POST: async (req: Request) => {
        try {
          if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);
          const body = await req.json() as { name?: string };
          if (!body.name) return error('Missing "name" field');
          const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
          const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
          const requestUrl = new URL(req.url);
          const host = forwardedHost || req.headers.get('host') || requestUrl.host;
          const protocol = forwardedProto || requestUrl.protocol.replace(':', '');
          const enrollmentOrigin = host ? `${protocol}://${host}` : undefined;
          const result = await ctx.sidecarManager.enrollSidecar(body.name, enrollmentOrigin);
          return json(result, 201);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('already enrolled') || msg.includes('may only contain')) {
            return error(msg, 409);
          }
          return error(msg);
        }
      },
    },

    '/api/sidecars/.well-known/jwks.json': {
      GET: () => {
        try {
          if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);
          return json(ctx.sidecarManager.getJwks());
        } catch (err) { return error(`${err}`); }
      },
    },

    '/api/sidecars/:id/config': {
      GET: async (req: Request) => {
        try {
          if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          if (!ctx.sidecarManager.isConnected(id)) {
            return error('Sidecar is not connected', 409);
          }
          const result = await ctx.sidecarManager.dispatchRPC(id, 'get_config', {});
          return json(result);
        } catch (err) { return error(`${err}`, 500); }
      },
      PATCH: async (req: Request) => {
        try {
          if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);
          const url = new URL(req.url);
          const parts = url.pathname.split('/');
          const id = parts[parts.length - 2]!;
          if (!ctx.sidecarManager.isConnected(id)) {
            return error('Sidecar is not connected', 409);
          }
          const body = await req.json() as Record<string, unknown>;
          delete body.token;
          const result = await ctx.sidecarManager.dispatchRPC(id, 'update_config', body);
          return json(result);
        } catch (err) { return error(`${err}`, 500); }
      },
    },

    '/api/sidecars/:id': {
      GET: (req: Request) => {
        try {
          if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          const sidecar = ctx.sidecarManager.getSidecar(id);
          if (!sidecar) return error('Sidecar not found', 404);
          return json(sidecar);
        } catch (err) { return error(`${err}`); }
      },
      DELETE: (req: Request) => {
        try {
          if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);
          const url = new URL(req.url);
          const id = url.pathname.split('/').pop()!;
          const revoked = ctx.sidecarManager.revokeSidecar(id);
          if (!revoked) return error('Sidecar not found or already revoked', 404);
          return json({ success: true });
        } catch (err) { return error(`${err}`); }
      },
    },

    // --- Site Builder ---
    '/api/sites/templates': {
      GET: () => {
        const { TEMPLATES } = require('../sites/templates.ts');
        return json(TEMPLATES);
      },
    },

    '/api/sites/git/check': {
      GET: async () => {
        const { GitManager } = require('../sites/git-manager.ts');
        const installed = await GitManager.isInstalled();
        if (!installed) return json({ installed: false, authorName: null, authorEmail: null });
        const author = await GitManager.getGlobalAuthor();
        return json({ installed: true, authorName: author.name, authorEmail: author.email });
      },
    },

    '/api/sites/projects': {
      GET: async () => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const projects = await ctx.siteBuilderService.listProjectsWithStatus();
        return json(projects);
      },
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        try {
          const body = await req.json() as { name: string; template: string; gitAuthor?: { name: string; email: string; global: boolean } };
          if (!body.name || !body.template) return error('name and template are required');
          const project = await ctx.siteBuilderService.projectManager.createProject(body.name, body.template, body.gitAuthor);
          return json(project, 201);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id': {
      GET: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const project = await ctx.siteBuilderService.getProjectWithStatus(id);
        if (!project) return error('Project not found', 404);
        return json(project);
      },
      DELETE: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        try {
          await ctx.siteBuilderService.stopProject(id);
          await ctx.siteBuilderService.projectManager.deleteProject(id);
          return json({ ok: true });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/start': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        try {
          const project = await ctx.siteBuilderService.startProject(id);
          return json(project);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/stop': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        try {
          await ctx.siteBuilderService.stopProject(id);
          return json({ ok: true });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/logs': {
      GET: (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const limit = parseInt(getSearchParams(req).get('limit') ?? '100', 10);
        const logs = ctx.siteBuilderService.devServerManager.getLogs(id, limit);
        return json({ logs });
      },
    },

    '/api/sites/projects/:id/files': {
      GET: (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        try {
          const tree = ctx.siteBuilderService.projectManager.getFileTree(id);
          return json(tree);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/file': {
      GET: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const filePath = getSearchParams(req).get('path');
        if (!filePath) return error('path query parameter is required');
        try {
          const content = await ctx.siteBuilderService.projectManager.readFile(id, filePath);
          return json({ path: filePath, content });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err), 404);
        }
      },
      PUT: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        try {
          const body = await req.json() as { path: string; content: string };
          if (!body.path || body.content === undefined) return error('path and content are required');
          await ctx.siteBuilderService.projectManager.writeFile(id, body.path, body.content);

          // Auto-commit if enabled
          const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
          if (projectPath) {
            await ctx.siteBuilderService.gitManager.autoCommit(projectPath, `Update ${body.path}`);
          }

          return json({ ok: true });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // --- Site Builder: Git ---
    '/api/sites/projects/:id/git/branches': {
      GET: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const branches = await ctx.siteBuilderService.gitManager.getBranches(projectPath);
          return json(branches);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const body = await req.json() as { name: string };
          if (!body.name) return error('name is required');
          await ctx.siteBuilderService.gitManager.createBranch(projectPath, body.name);
          return json({ ok: true, branch: body.name });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/git/branch': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const body = await req.json() as { name: string };
          if (!body.name) return error('name is required');
          await ctx.siteBuilderService.gitManager.switchBranch(projectPath, body.name);
          return json({ ok: true, branch: body.name });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/git/log': {
      GET: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        const limit = parseInt(getSearchParams(req).get('limit') ?? '50', 10);
        try {
          const commits = await ctx.siteBuilderService.gitManager.getLog(projectPath, limit);
          return json(commits);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/git/diff': {
      GET: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const diff = await ctx.siteBuilderService.gitManager.getDiff(projectPath);
          return json({ diff });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/git/commit': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const body = await req.json() as { message: string };
          if (!body.message) return error('message is required');
          const commit = await ctx.siteBuilderService.gitManager.autoCommit(projectPath, body.message);
          if (!commit) return json({ ok: false, message: 'Nothing to commit' });
          return json({ ok: true, commit });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/git/merge': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const body = await req.json() as { branch: string; strategy?: 'merge' | 'rebase' };
          if (!body.branch) return error('branch is required');

          const result = body.strategy === 'rebase'
            ? await ctx.siteBuilderService.gitManager.rebase(projectPath, body.branch)
            : await ctx.siteBuilderService.gitManager.merge(projectPath, body.branch);

          return json(result);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // --- Site Builder: GitHub Integration ---
    '/api/sites/github/token': {
      GET: async () => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const gh = ctx.siteBuilderService.githubManager;
        if (!gh.hasToken()) return json({ hasToken: false, username: null });
        const { valid, username } = await gh.validateToken();
        return json({ hasToken: valid, username });
      },
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        try {
          const body = await req.json() as { token: string };
          if (!body.token) return error('token is required');
          const gh = ctx.siteBuilderService.githubManager;
          gh.setToken(body.token);
          const { valid, username, scopes } = await gh.validateToken();
          if (!valid) {
            gh.deleteToken();
            return error('Invalid token — could not authenticate with GitHub', 401);
          }
          return json({ ok: true, username, scopes });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
      DELETE: () => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        ctx.siteBuilderService.githubManager.deleteToken();
        return json({ ok: true });
      },
    },

    '/api/sites/github/repos': {
      GET: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        try {
          const page = parseInt(getSearchParams(req).get('page') ?? '1', 10);
          const repos = await ctx.siteBuilderService.githubManager.listUserRepos(page);
          return json(repos);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/github/repo': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const body = await req.json() as {
            name?: string; description?: string; private?: boolean;
            existingRepo?: string; // "owner/repo" format
          };
          const gh = ctx.siteBuilderService.githubManager;
          let owner: string, repo: string, cloneUrl: string, htmlUrl: string;

          if (body.existingRepo) {
            // Connect to existing repo
            const [o, r] = body.existingRepo.split('/');
            if (!o || !r) return error('existingRepo must be in "owner/repo" format');
            const info = await gh.getRepo(o, r);
            owner = info.owner; repo = info.repo; cloneUrl = info.cloneUrl; htmlUrl = info.htmlUrl;
          } else {
            // Create new repo
            if (!body.name) return error('name is required (or provide existingRepo)');
            const info = await gh.createRepo({
              name: body.name,
              description: body.description,
              private: body.private ?? true,
            });
            owner = info.owner; repo = info.repo; cloneUrl = info.cloneUrl; htmlUrl = info.htmlUrl;
          }

          // Add/update remote origin
          await gh.addRemote(projectPath, cloneUrl);

          // Persist GitHub metadata
          await ctx.siteBuilderService.projectManager.updateGitHubMeta(id, {
            owner, repo, remoteUrl: cloneUrl, lastPushedAt: null,
          });

          const project = await ctx.siteBuilderService.getProjectWithStatus(id);
          return json(project, 201);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
      DELETE: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          await ctx.siteBuilderService.githubManager.removeRemote(projectPath);
          await ctx.siteBuilderService.projectManager.updateGitHubMeta(id, null);
          return json({ ok: true });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/github/push': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const body = await req.json().catch(() => ({})) as { force?: boolean };
          const result = await ctx.siteBuilderService.githubManager.push(projectPath, undefined, body.force);
          if (!result.success) return error(result.error ?? 'Push failed');

          // Update lastPushedAt
          const project = await ctx.siteBuilderService.projectManager.getProject(id);
          if (project?.githubUrl) {
            const meta = require('node:fs').readFileSync(
              require('node:path').join(projectPath, '.jarvis-project.json'), 'utf-8'
            );
            const parsed = JSON.parse(meta);
            if (parsed.github) {
              parsed.github.lastPushedAt = Date.now();
              await Bun.write(require('node:path').join(projectPath, '.jarvis-project.json'), JSON.stringify(parsed, null, 2));
            }
          }

          return json({ ok: true });
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/github/pull': {
      POST: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const result = await ctx.siteBuilderService.githubManager.pull(projectPath);
          return json(result);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    '/api/sites/projects/:id/github/status': {
      GET: async (req: Request) => {
        if (!ctx.siteBuilderService) return error('Site builder not available', 503);
        const id = new URL(req.url).pathname.split('/')[4]!;
        const projectPath = ctx.siteBuilderService.projectManager.getProjectPath(id);
        if (!projectPath) return error('Project not found', 404);
        try {
          const status = await ctx.siteBuilderService.githubManager.getRemoteStatus(projectPath);
          return json(status);
        } catch (err) {
          return error(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // --- CORS preflight ---
    '/api/*': {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS }),
    },
  };
}
