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
import { applyQuickOverride } from '../authority/quick-override.ts';
import type { ActionCategory } from '../roles/authority.ts';

import { findEntities, getEntity, searchEntitiesByName, createEntity } from '../vault/entities.ts';
import { findFacts, createFact } from '../vault/facts.ts';
import { findRelationships, getEntityRelationships, createRelationship } from '../vault/relationships.ts';

const VALID_ENTITY_TYPES = new Set(['person', 'project', 'tool', 'place', 'concept', 'event']);
import { getDb } from '../vault/schema.ts';
import { findCommitments, getUpcoming, createCommitment, getCommitment, updateCommitmentStatus, reorderCommitments } from '../vault/commitments.ts';
import { getOrCreateConversation, getMessages, getRecentConversation } from '../vault/conversations.ts';
import { getRecentObservations, summarizeObservation } from '../vault/observations.ts';
import { listAgentActivity, countAgentActivity } from '../vault/agent-activity.ts';
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
import { isWithin } from '../util/path.ts';

// --- Security helpers ---

/** HTML-escape to prevent XSS in inline HTML responses */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Sanitize a single path segment — strip directory separators and dot-dot sequences */
function sanitizePathSegment(segment: string): string {
  return path.basename(segment.replace(/\.\./g, ''));
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
  /**
   * Daemon process boot time (Date.now() at start). Surfaced via the
   * onboarding-status endpoint so the dashboard can detect when setup
   * was completed AFTER the daemon started — that's the case where
   * the daemon is still in setup-mode and needs a restart for
   * background services (heartbeat / commitments / awareness) to
   * spin up. Until those services can construct in-process at setup
   * completion, the dashboard renders a "Restart Jarvis" banner when
   * `setup_completed_at > daemon_started_at`. (See also issue F2.)
   */
  daemonStartedAt: number;
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
  /**
   * Bring the LLM-dependent post-setup services (background agent,
   * commitment executor, awareness) online in-process. Wired by the
   * daemon at boot. Called by `/api/onboarding/setup` so the user does
   * not have to restart the daemon at the end of onboarding — critical
   * for Docker / VPS deploys where a process restart is disruptive.
   * Idempotent: a no-op if the services are already running.
   */
  startPostSetupServices?: () => Promise<void>;
  /**
   * Reports whether the post-setup services have come online. Used by
   * the onboarding status endpoint so the dashboard knows whether to
   * show the "Restart Jarvis" fallback banner.
   */
  isPostSetupServicesReady?: () => boolean;
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
      // Phase 6.5 — write surface for the Memory Room. Routes through
      // createEntity directly; the LLM-driven extractor pipeline keeps
      // its own internal call site for auto-extraction, this is for
      // explicit user-driven adds (UI button or voice "remember that").
      POST: async (req: Request) => {
        try {
          const body = await req.json() as {
            name?: string;
            type?: EntityType;
            properties?: Record<string, unknown>;
            source?: string;
          };
          if (!body.name || typeof body.name !== 'string') return error('name is required', 400);
          if (!body.type || !VALID_ENTITY_TYPES.has(body.type)) {
            return error(`type must be one of: ${Array.from(VALID_ENTITY_TYPES).join(', ')}`, 400);
          }
          const entity = createEntity(body.type, body.name, body.properties, body.source ?? 'dashboard');
          return json(entity);
        } catch (err) { return errorFromException(err); }
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
      POST: async (req: Request) => {
        try {
          const body = await req.json() as {
            subject_id?: string;
            predicate?: string;
            object?: string;
            confidence?: number;
            source?: string;
          };
          if (!body.subject_id || !body.predicate || !body.object) {
            return error('subject_id, predicate, and object are required', 400);
          }
          const subject = getEntity(body.subject_id);
          if (!subject) return error(`Unknown subject_id: ${body.subject_id}`, 404);
          const fact = createFact(body.subject_id, body.predicate, body.object, {
            confidence: body.confidence,
            source: body.source ?? 'dashboard',
          });
          return json(fact);
        } catch (err) { return errorFromException(err); }
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
      POST: async (req: Request) => {
        try {
          const body = await req.json() as {
            from_id?: string;
            to_id?: string;
            type?: string;
            properties?: Record<string, unknown>;
          };
          if (!body.from_id || !body.to_id || !body.type) {
            return error('from_id, to_id, and type are required', 400);
          }
          const from = getEntity(body.from_id);
          const to = getEntity(body.to_id);
          if (!from) return error(`Unknown from_id: ${body.from_id}`, 404);
          if (!to) return error(`Unknown to_id: ${body.to_id}`, 404);
          const rel = createRelationship(body.from_id, body.to_id, body.type, body.properties);
          return json(rel);
        } catch (err) { return errorFromException(err); }
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
        const summarized = params.get('summarized') === 'true';
        const obs = getRecentObservations(type, limit);
        if (!summarized) return json(obs);
        // Phase 5B: when ?summarized=true, project each row into the
        // stable {title, summary, type, created_at} shape the dashboard
        // can render uniformly across all observation types.
        return json(obs.map((o) => ({ ...summarizeObservation(o), data: o.data })));
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

    // Phase 6.3 — per-agent activity history. Persisted snapshot of
    // sub-agent events so the Agents Room shows a meaningful timeline on
    // dashboard load (not just whatever streamed since the WS opened).
    '/api/agents/:id/activity': {
      GET: (req: Request & { params: { id: string } }) => {
        try {
          const url = new URL(req.url);
          const limitParam = parseInt(url.searchParams.get('limit') ?? '', 10);
          const offsetParam = parseInt(url.searchParams.get('offset') ?? '', 10);
          const limit = Number.isFinite(limitParam) ? limitParam : 50;
          const offset = Number.isFinite(offsetParam) ? offsetParam : 0;
          const events = listAgentActivity(req.params.id, { limit, offset });
          const total = countAgentActivity(req.params.id);
          return json({ events, total });
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

    // ── Onboarding ──────────────────────────────────────────────────
    // Status + reset endpoints powering the v2 onboarding gate. See
    // `docs/ONBOARDING_PLAN.md`. Reset is intentionally available on
    // demand (not behind a build flag) so users can replay the tour
    // after a Jarvis update or when swapping LLM providers.

    '/api/onboarding/status': {
      GET: async () => {
        try {
          const { loadConfig } = await import('../config/loader.ts');
          const cfg = await loadConfig();
          const o = cfg.onboarding;
          // `getUserProfile` and `hasUserProfile` are already imported
          // at the top of the file. Use `hasUserProfile()` so the
          // check counts wizard answers AND Phase B interview facts —
          // otherwise a user who completed the conversational
          // interview (but never used the wizard) gets reported as
          // "not yet onboarded" and the gate loops them back into
          // the interview.
          const profile = getUserProfile();
          const profileCompleted =
            !!o?.setup_skipped_profile || hasUserProfile(profile);
          return json({
            setup_completed: o?.setup_completed_at != null,
            setup_completed_at: o?.setup_completed_at ?? null,
            setup_skipped_profile: !!o?.setup_skipped_profile,
            profile_completed: profileCompleted,
            tutorial_completed: o?.tutorial_completed_at != null,
            tutorial_completed_at: o?.tutorial_completed_at ?? null,
            tutorial_dismissed: o?.tutorial_dismissed_at != null,
            tutorial_progress_step: o?.tutorial_progress_step ?? null,
            last_reset_at: o?.last_reset_at ?? null,
            // Boot timestamp + post-setup readiness let the dashboard
            // detect whether the background services (bgAgent, commitment
            // executor, awareness) are actually running. With in-process
            // construction at `/api/onboarding/setup`, no restart is
            // needed in the normal flow; the banner only shows if that
            // construction step failed.
            daemon_started_at: ctx.daemonStartedAt,
            post_setup_services_ready: ctx.isPostSetupServicesReady?.() ?? false,
          });
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    '/api/onboarding/reset': {
      POST: async (req: Request) => {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            scope?: 'all' | 'setup' | 'profile' | 'tutorial';
          };
          const scope = body?.scope ?? 'all';
          if (!['all', 'setup', 'profile', 'tutorial'].includes(scope)) {
            return error(`Invalid scope "${scope}".`, 400);
          }

          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const fresh = await loadConfig();
          const o = fresh.onboarding ?? {
            setup_completed_at: null,
            tutorial_completed_at: null,
          };

          const cleared: string[] = [];
          if (scope === 'all' || scope === 'setup') {
            o.setup_completed_at = null;
            cleared.push('setup');
          }
          if (scope === 'all' || scope === 'profile') {
            o.setup_skipped_profile = false;
            clearUserProfile();
            cleared.push('profile');
          }
          if (scope === 'all' || scope === 'tutorial') {
            o.tutorial_completed_at = null;
            o.tutorial_dismissed_at = null;
            o.tutorial_progress_step = undefined;
            cleared.push('tutorial');
          }
          o.last_reset_at = Date.now();
          fresh.onboarding = o;
          await saveConfig(fresh);

          // Mirror to in-memory config so the next /status read is
          // immediately consistent (don't wait for daemon restart).
          ctx.config.onboarding = o;

          // localStorage keys the client should also clear after this
          // call. Returned in the response so the UI handler doesn't
          // have to know about cache layers it didn't write.
          const clientCacheKeys = ['jarvis:notif-read', 'jarvis:palette-recent'];
          if (scope === 'all') {
            clientCacheKeys.push('jarvis:v2:workspaces-ui');
            clientCacheKeys.push('jarvis:room-layout');
          }

          return json({
            ok: true,
            scope,
            cleared,
            client_cache_keys: clientCacheKeys,
            message: `Onboarding reset (${cleared.join(', ')}).`,
          });
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    /**
     * Phase B — user skipped the conversational profile interview.
     * Sets `setup_skipped_profile: true` so the gate stops re-rendering
     * Phase B. Profile remains empty; user can fill it later via the
     * Settings → Profile wizard or by saying "redo the profile interview".
     */
    '/api/onboarding/profile/skip': {
      POST: async () => {
        try {
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const fresh = await loadConfig();
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            ...fresh.onboarding,
            setup_skipped_profile: true,
          };
          await saveConfig(fresh);
          ctx.config.onboarding = fresh.onboarding;
          return json({ ok: true, setup_skipped_profile: true });
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    // ── Phase C — tutorial completion endpoints ─────────────────────
    // Three small endpoints powering the spotlight walkthrough's
    // persistence: complete (user finished), dismiss (user skipped),
    // progress (resume-from-step support). All three write through
    // the same loadConfig → mutate → saveConfig pattern as the rest
    // of the onboarding routes; the existing reset endpoint with
    // `scope: "tutorial"` already clears all three fields.

    '/api/onboarding/tutorial/complete': {
      POST: async () => {
        try {
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const fresh = await loadConfig();
          const now = Date.now();
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            ...fresh.onboarding,
            tutorial_completed_at: now,
            tutorial_progress_step: undefined,
          };
          await saveConfig(fresh);
          ctx.config.onboarding = fresh.onboarding;
          return json({ ok: true, tutorial_completed_at: now });
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    '/api/onboarding/tutorial/dismiss': {
      POST: async () => {
        try {
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const fresh = await loadConfig();
          const now = Date.now();
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            ...fresh.onboarding,
            tutorial_dismissed_at: now,
          };
          await saveConfig(fresh);
          ctx.config.onboarding = fresh.onboarding;
          return json({ ok: true, tutorial_dismissed_at: now });
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    '/api/onboarding/tutorial/progress': {
      POST: async (req: Request) => {
        try {
          const body = (await req.json().catch(() => ({}))) as { stepId?: string };
          const stepId = typeof body.stepId === 'string' ? body.stepId.trim() : '';
          if (!stepId) return error('Missing stepId.', 400);
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const fresh = await loadConfig();
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            ...fresh.onboarding,
            tutorial_progress_step: stepId,
          };
          await saveConfig(fresh);
          ctx.config.onboarding = fresh.onboarding;
          return json({ ok: true, tutorial_progress_step: stepId });
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    /**
     * Phase C — tutorial narration TTS broadcast. Speaks `text`
     * through the existing TTS provider so the AppShell's `useVoice`
     * picks it up via the regular `tts_start` + binary chunks path.
     * The orb pulses speaking; the tutorial bubble mirrors it.
     * Synchronous-ish: returns when synthesis completes (so the UI
     * can advance to listening for the next "next" command).
     */
    '/api/onboarding/tutorial/speak': {
      POST: async (req: Request) => {
        try {
          const body = (await req.json().catch(() => ({}))) as { text?: string };
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return error('Missing text.', 400);
          if (!ctx.wsService) return error('WS service unavailable.', 503);
          // Reuse the proactive TTS broadcast — it already wraps with
          // tts_start (with containsWake flag), streams binary chunks,
          // and emits tts_end. No new transport.
          await ctx.wsService.broadcastProactiveVoice(text);
          return json({ ok: true });
        } catch (err) {
          return errorFromException(err);
        }
      },
    },

    /**
     * Atomic Phase A setup endpoint. Saves LLM + TTS config + flips
     * the `onboarding.setup_completed_at` flag in one shot, then hot-
     * reloads the LLM providers and TTS provider so the next chat
     * message goes through real services without a daemon restart.
     *
     * Body shape:
     *   {
     *     llm: {
     *       primary: "anthropic" | "openai" | ... ,
     *       <provider>: { api_key?: string, model?: string, base_url?: string }
     *     },
     *     tts: {
     *       enabled: boolean,
     *       provider?: "edge" | "elevenlabs" | "sarvam",
     *       voice?: string,
     *       rate?: string,
     *       elevenlabs?: { api_key?: string, voice_id?: string, model?: string },
     *     }
     *   }
     *
     * Either field is optional; missing means "use current/default".
     * The TTS block is required to be present (even if just `{enabled:false}`)
     * so the user explicitly chose during the setup screen.
     */
    '/api/onboarding/setup': {
      POST: async (req: Request) => {
        try {
          const body = (await req.json()) as {
            llm?: Record<string, unknown>;
            tts?: Record<string, unknown>;
          };

          // 1. LLM settings — same path as /api/config/llm POST.
          if (body.llm && Object.keys(body.llm).length > 0) {
            const { saveLLMSettings, hotReloadLLMProviders } = await import('./llm-settings.ts');
            saveLLMSettings(ctx.config, body.llm as any);
            hotReloadLLMProviders(ctx.config, ctx.agentService.getLLMManager());
          }

          // 2. TTS settings — same path as /api/config/tts POST. Inline
          //    the relevant write since the TTS endpoint is large; we
          //    don't need provider hot-swap UI feedback here.
          if (body.tts) {
            const { loadConfig: lc, saveConfig: sc } = await import('../config/loader.ts');
            const fresh = await lc();
            fresh.tts = { ...fresh.tts, ...(body.tts as any) };
            await sc(fresh);
            ctx.config.tts = fresh.tts;
            // Hot-reload TTS provider when possible so the post-setup
            // "Welcome to Jarvis" reply is spoken immediately.
            try {
              if (ctx.config.tts && ctx.wsService) {
                const { createTTSProvider } = await import('../comms/voice.ts');
                const provider = await createTTSProvider(ctx.config.tts);
                if (provider) ctx.wsService.setTTSProvider(provider);
              }
            } catch (err) {
              console.warn('[Onboarding] TTS hot-reload skipped:', err);
            }
          }

          // 3. Flip the setup-completed flag.
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const fresh = await loadConfig();
          const now = Date.now();
          fresh.onboarding = {
            setup_completed_at: now,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            setup_skipped_profile: fresh.onboarding?.setup_skipped_profile,
            tutorial_dismissed_at: fresh.onboarding?.tutorial_dismissed_at,
            tutorial_progress_step: fresh.onboarding?.tutorial_progress_step,
            last_reset_at: fresh.onboarding?.last_reset_at,
          };
          await saveConfig(fresh);
          ctx.config.onboarding = fresh.onboarding;

          // 4. Bring the LLM-dependent services (bgAgent, commitment
          //    executor, awareness) online in-process. Without this the
          //    user would have to restart the daemon — fatal UX on
          //    Docker / VPS. Failure here is non-fatal: chat still works
          //    via the hot-reloaded LLM, just without background features
          //    until the next daemon restart.
          let postSetupStarted = false;
          if (ctx.startPostSetupServices) {
            try {
              await ctx.startPostSetupServices();
              postSetupStarted = true;
            } catch (err) {
              console.error(
                '[Onboarding] Failed to start post-setup services in-process:',
                err instanceof Error ? err.message : err,
              );
            }
          }

          return json({
            ok: true,
            setup_completed_at: now,
            post_setup_services_started: postSetupStarted,
            message: 'Setup complete. Jarvis is ready.',
          });
        } catch (err) {
          return errorFromException(err);
        }
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
            openai_compatible: config.llm.openai_compatible
              ? {
                  base_url: config.llm.openai_compatible.base_url,
                  model: config.llm.openai_compatible.model,
                }
              : null,
          },
          personality: config.personality,
          authority: config.authority,
          heartbeat: config.heartbeat,
          active_role: config.active_role,
          voice: config.voice ?? { wake_engine: 'openwakeword' },
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

    // Live model catalog for NVIDIA. NVIDIA's `/v1/models` is publicly
    // readable, so this works during onboarding before any key is stored.
    // We pass the user's key through when available so the call still
    // authenticates if NVIDIA ever requires it. Mixes chat / embedding /
    // vision models — the UI shows them all and relies on the connection
    // test to weed out anything that can't speak /v1/chat/completions.
    '/api/config/llm/nvidia/models': {
      GET: async () => {
        try {
          const { NVIDIAProvider } = await import('../llm/nvidia.ts');
          const key = ctx.config.llm.nvidia?.api_key ?? '';
          const provider = new NVIDIAProvider(key);
          const models = await provider.listModels();
          return json({ ok: true, models });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ ok: false, error: msg, models: [] });
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
          if (!isWithin(diskPath, path.resolve(baseDir))) {
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
        if (!isWithin(filePath, path.resolve(baseDir))) {
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
          sarvam_language: stt?.sarvam?.language ?? 'unknown',
          local_endpoint: stt?.local?.endpoint ?? null,
          local_server_type: stt?.local?.server_type ?? 'whisper_cpp',
        });
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as Record<string, unknown>;
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();

          if (!freshConfig.stt) freshConfig.stt = { provider: 'openai' };
          const stt = freshConfig.stt;

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

          if (!freshConfig.tts) freshConfig.tts = { enabled: false };

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
        const rows =
          status === 'pending'
            ? ctx.approvalManager.getPending()
            : ctx.approvalManager.getHistory({
                limit: parseInt(params.get('limit') ?? '50') || 50,
                action: (params.get('action') as ActionCategory) || undefined,
                agentId: params.get('agent_id') || undefined,
                status: (params.get('status') as any) || undefined,
              });

        // Phase 5B audit fix: enrich the REST response with the same
        // `intent` + `impact` fields the WS broadcasts already carry, so
        // dashboard rehydration on reconnect doesn't have to derive them
        // client-side from `tool_name` + `action_category`.
        const { impactFromCategory } = require('../roles/authority.ts');
        const wsService = ctx.wsService as
          | { computeApprovalIntent?: (r: typeof rows[number]) => string }
          | undefined;

        const enriched = rows.map((r) => ({
          ...r,
          impact: impactFromCategory(r.action_category as ActionCategory),
          intent:
            wsService?.computeApprovalIntent?.(r) ??
            (r.reason && r.reason.trim() ? r.reason : r.tool_name),
        }));

        return json(enriched);
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

        // Intent-declaration approvals have no deferred tool to execute —
        // the originating `request_approval` tool call is blocked waiting for
        // the DB status to flip (via waitForResolution polling). Skipping
        // executeApproved avoids a recursive call into the tool registry.
        let result = '';
        if (approved.tool_name !== 'request_approval') {
          result = await ctx.deferredExecutor.executeApproved(requestId);
        }

        // Broadcast the update (removes the card from the dashboard thread)
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

    /**
     * Palette recent picks — daemon-side LRU surviving reload + cross-device.
     * The UI also keeps a localStorage cache as an offline fallback.
     */
    '/api/palette/recent': {
      GET: (req: Request) => {
        const { listRecentObjects } = require('../vault/recent-objects.ts');
        const params = getSearchParams(req);
        const limit = Math.min(parseInt(params.get('limit') ?? '5') || 5, 50);
        const rows = listRecentObjects(limit) as Array<{
          object_type: string;
          object_id: string;
          title: string;
          summary: string | null;
          meta: string | null;
          picked_at: number;
        }>;
        return json({
          recent: rows.map((r) => ({
            type: r.object_type,
            id: r.object_id,
            ref: r.object_id,
            title: r.title,
            summary: r.summary ?? undefined,
            meta: r.meta ?? undefined,
            pickedAt: r.picked_at,
          })),
        });
      },
      POST: async (req: Request) => {
        try {
          const body = (await req.json()) as {
            type?: string;
            id?: string;
            title?: string;
            summary?: string;
            meta?: string;
          };
          if (!body.type || !body.id || !body.title) {
            return error('type, id, and title are required', 400);
          }
          const { recordRecentObject } = require('../vault/recent-objects.ts');
          recordRecentObject({
            object_type: body.type,
            object_id: body.id,
            title: body.title,
            summary: body.summary,
            meta: body.meta,
          });
          return json({ ok: true });
        } catch (err) {
          return error(err instanceof Error ? err.message : 'failed', 500);
        }
      },
    },

    /**
     * Tool registry exposure for the ⌘K palette and the Phase 6 Tools Room.
     * Returns every registered tool with its category, impact classification,
     * and parameter list. Impact is derived via the same `tool-action-map` +
     * `impactFromCategory` chain the orchestrator uses at gate time, so the
     * Room shows exactly the impact the user would actually face on call.
     */
    '/api/tools': {
      GET: () => {
        const orchestrator = ctx.agentService.getOrchestrator();
        const registry = orchestrator.getToolRegistry();
        if (!registry) return json([]);
        const { getActionForTool } = require('../authority/tool-action-map.ts');
        const { impactFromCategory } = require('../roles/authority.ts');
        const tools = registry.list().map((t) => {
          const actionCategory = getActionForTool(t.name, t.category);
          const impact = impactFromCategory(actionCategory);
          return {
            name: t.name,
            category: t.category,
            actionCategory,
            impact,
            description: t.description,
            parameters: Object.entries(t.parameters).map(([k, v]) => ({
              name: k,
              type: v.type,
              description: v.description,
              required: v.required,
            })),
          };
        });
        return json(tools);
      },
    },

    /**
     * Unified palette search aggregator. Merges all six object types into a
     * single `PaletteResult[]` shape that maps directly to `<InlineCard>`
     * props on the UI side. Each type is bounded so a single overflowing
     * type can't crowd out the others.
     *
     * Empty `q` returns a small "recent / popular" slice per type so the
     * palette has something useful to show on first open.
     *
     * Substring matching is case-insensitive. Client-side fuzzy ranking
     * (`fuse.js`) refines order on top of these results.
     */
    '/api/palette/search': {
      GET: (req: Request) => {
        const params = getSearchParams(req);
        const q = (params.get('q') ?? '').trim();
        const perType = Math.min(parseInt(params.get('per_type') ?? '6') || 6, 20);
        const ql = q.toLowerCase();
        const matches = (s: string | undefined | null): boolean =>
          !ql || (typeof s === 'string' && s.toLowerCase().includes(ql));

        type PaletteResult = {
          type: 'workflow' | 'memory' | 'tool' | 'agent' | 'authority' | 'log';
          id: string;
          ref: string;
          title: string;
          summary?: string;
          meta?: string;
          status?: { label: string; tone: 'ok' | 'warn' | 'neutral' | 'accent' };
        };

        const results: PaletteResult[] = [];

        // 1. Workflows
        try {
          const { findWorkflows } = require('../vault/workflows.ts');
          const wfs = findWorkflows({ limit: 100 }) as Array<{
            id: string;
            name: string;
            description?: string;
            enabled?: boolean;
            tags?: string[];
            current_version?: number;
            execution_count?: number;
            last_executed_at?: number | null;
          }>;
          let added = 0;
          for (const w of wfs) {
            if (added >= perType) break;
            if (!matches(w.name) && !matches(w.description)) continue;
            // Phase 5B: enrich the meta line with version + run count when
            // available so the palette row tells the user what they're picking
            // beyond just tags.
            const metaParts: string[] = [];
            if (typeof w.current_version === 'number') metaParts.push(`v${w.current_version}`);
            if (typeof w.execution_count === 'number') {
              metaParts.push(`${w.execution_count} ${w.execution_count === 1 ? 'run' : 'runs'}`);
            }
            if (w.tags && w.tags.length > 0) metaParts.push(w.tags.join(' · '));
            results.push({
              type: 'workflow',
              id: w.id,
              ref: w.id,
              title: w.name,
              summary: w.description,
              meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
              status: w.enabled
                ? { label: 'Enabled', tone: 'ok' }
                : { label: 'Disabled', tone: 'neutral' },
            });
            added++;
          }
        } catch (err) {
          console.warn('[palette] workflow search failed:', err);
        }

        // 2. Memory entities (vault)
        try {
          const entityResults = ql
            ? searchEntitiesByName(q).slice(0, perType * 2)
            : findEntities({}).slice(0, perType);
          let added = 0;
          for (const e of entityResults) {
            if (added >= perType) break;
            const props = (e.properties ?? {}) as Record<string, unknown>;
            const desc = typeof props.description === 'string' ? props.description : undefined;
            results.push({
              type: 'memory',
              id: e.id,
              ref: e.id,
              title: e.name,
              summary: desc,
              meta: e.type,
            });
            added++;
          }
        } catch (err) {
          console.warn('[palette] memory search failed:', err);
        }

        // 3. Tools (from the orchestrator registry)
        try {
          const orchestrator = ctx.agentService.getOrchestrator();
          const registry = orchestrator.getToolRegistry();
          if (registry) {
            let added = 0;
            for (const t of registry.list()) {
              if (added >= perType) break;
              if (!matches(t.name) && !matches(t.description)) continue;
              results.push({
                type: 'tool',
                id: t.name,
                ref: t.name,
                title: t.name,
                summary: t.description,
                meta: t.category,
              });
              added++;
            }
          }
        } catch (err) {
          console.warn('[palette] tool search failed:', err);
        }

        // 4. Agents
        try {
          const agents = buildAgentSnapshots(ctx).agents as Array<{
            id: string;
            role?: { name?: string; description?: string };
            status?: string;
            isBusy?: boolean;
          }>;
          let added = 0;
          for (const a of agents) {
            if (added >= perType) break;
            const name = a.role?.name ?? a.id;
            const desc = a.role?.description;
            if (!matches(name) && !matches(desc)) continue;
            results.push({
              type: 'agent',
              id: a.id,
              ref: a.id,
              title: name,
              summary: desc,
              meta: a.status,
              status: a.isBusy
                ? { label: 'Busy', tone: 'warn' }
                : { label: 'Idle', tone: 'neutral' },
            });
            added++;
          }
        } catch (err) {
          console.warn('[palette] agent search failed:', err);
        }

        // 5. Authority — pending approvals
        try {
          const mgr = ctx.approvalManager;
          if (mgr) {
            const pending = mgr.getPending();
            let added = 0;
            for (const a of pending) {
              if (added >= perType) break;
              if (!matches(a.reason) && !matches(a.tool_name) && !matches(a.action_category)) continue;
              results.push({
                type: 'authority',
                id: a.id,
                ref: a.id,
                title: a.reason || a.tool_name,
                summary: `${a.tool_name} · ${a.action_category}`,
                meta: a.urgency,
                status: { label: 'Pending', tone: 'warn' },
              });
              added++;
            }
          }
        } catch (err) {
          console.warn('[palette] authority search failed:', err);
        }

        // 6. Logs (recent observations) — normalized via summarizeObservation
        try {
          const obs = getRecentObservations(undefined, perType * 4);
          let added = 0;
          for (const o of obs) {
            if (added >= perType) break;
            const sum = summarizeObservation(o);
            if (!matches(sum.title) && !matches(sum.summary)) continue;
            results.push({
              type: 'log',
              id: o.id,
              ref: o.id,
              title: sum.title,
              summary: sum.summary || undefined,
              meta: new Date(o.created_at).toLocaleTimeString(),
            });
            added++;
          }
        } catch (err) {
          console.warn('[palette] log search failed:', err);
        }

        return json({ q, results });
      },
    },

    /**
     * Voice clarifier / repeat-back resolution.
     * The daemon holds a pending utterance when the classifier confidence is
     * <0.85; the dashboard renders a clarifier or repeat-back card; this
     * endpoint resolves it. `confirm` forwards the held transcript to the
     * chat agent; `cancel` drops the request silently (the user-voice
     * ThreadItem stays in the thread, no assistant reply follows).
     */
    '/api/voice/clarifier/:id/confirm': {
      POST: async (req: Request & { params: { id: string } }) => {
        if (!ctx.wsService) return error('WS service not configured', 500);
        const result = await ctx.wsService.resolveVoiceConfirmation(req.params.id, 'confirm');
        if (!result.ok) return error(result.reason ?? 'resolve failed', 404);
        return json({ ok: true });
      },
    },
    '/api/voice/clarifier/:id/cancel': {
      POST: async (req: Request & { params: { id: string } }) => {
        if (!ctx.wsService) return error('WS service not configured', 500);
        const result = await ctx.wsService.resolveVoiceConfirmation(req.params.id, 'cancel');
        if (!result.ok) return error(result.reason ?? 'resolve failed', 404);
        return json({ ok: true });
      },
    },
    '/api/voice/repeat-back/:id/confirm': {
      POST: async (req: Request & { params: { id: string } }) => {
        if (!ctx.wsService) return error('WS service not configured', 500);
        const result = await ctx.wsService.resolveVoiceConfirmation(req.params.id, 'confirm');
        if (!result.ok) return error(result.reason ?? 'resolve failed', 404);
        return json({ ok: true });
      },
    },
    '/api/voice/repeat-back/:id/cancel': {
      POST: async (req: Request & { params: { id: string } }) => {
        if (!ctx.wsService) return error('WS service not configured', 500);
        const result = await ctx.wsService.resolveVoiceConfirmation(req.params.id, 'cancel');
        if (!result.ok) return error(result.reason ?? 'resolve failed', 404);
        return json({ ok: true });
      },
    },

    /**
     * LLM-quality "Try saying" suggestions for the voice rail. Body:
     * `{ recentTurns: [{ role: 'user'|'assistant', text: string }, ...] }`.
     * Returns `{ suggestions: string[] }` (3–5 items, never destructive).
     * Empty array on cold-start or any LLM failure — the client falls back
     * to its heuristic in that case.
     */
    '/api/voice/suggestions': {
      POST: async (req: Request) => {
        try {
          const body = (await req.json()) as { recentTurns?: unknown };
          const llm = ctx.agentService.getLLMManager();
          const turns = Array.isArray(body.recentTurns)
            ? body.recentTurns
                .filter(
                  (t): t is { role: 'user' | 'assistant'; text: string } =>
                    !!t && typeof t === 'object'
                    && (((t as { role?: unknown }).role === 'user') || ((t as { role?: unknown }).role === 'assistant'))
                    && typeof (t as { text?: unknown }).text === 'string',
                )
                .slice(-5)
            : [];

          const { generateVoiceSuggestions } = await import('../agents/voice-suggestions.ts');
          const suggestions = await generateVoiceSuggestions(turns, llm);
          return json({ suggestions });
        } catch (err) {
          console.warn('[api] voice suggestions error:', err);
          return json({ suggestions: [] });
        }
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

    /**
     * Phase 6.6 — voice-friendly grant/revoke. Adds (or updates) a single
     * per-action override to the authority config without exposing the
     * full schema. Used by the Authority Room voice actions
     * "grant_access" and "revoke_access" so the user can say
     * "grant Jarvis email access" and have it persist.
     *
     * Body: { action: ActionCategory, allow: boolean, role_id?: string }
     * Returns: { ok: true, config: AuthorityConfig }
     *
     * Idempotent: if a global override for the action already exists,
     * its `allowed` flag is updated. Otherwise a new entry is appended.
     * Role-scoped overrides (when `role_id` is provided) are matched by
     * (action, role_id) tuple.
     */
    '/api/authority/config/quick-override': {
      POST: async (req: Request) => {
        if (!ctx.authorityEngine) return error('Authority engine not configured', 500);
        try {
          const body = await req.json() as { action?: ActionCategory; allow?: boolean; role_id?: string };
          if (!body.action) return error('Missing "action" field', 400);
          if (typeof body.allow !== 'boolean') return error('Missing "allow" boolean', 400);

          const validActions: ReadonlyArray<ActionCategory> = [
            'read_data', 'write_data', 'delete_data',
            'send_message', 'send_email',
            'execute_command', 'install_software',
            'make_payment', 'modify_settings',
            'spawn_agent', 'terminate_agent',
            'access_browser', 'control_app',
          ];
          if (!validActions.includes(body.action)) {
            return error(`Invalid action: ${body.action}`, 400);
          }

          // Single source of truth for the merge logic - shared with
          // the unit test in quick-override.test.ts so they can't drift.
          const currentConfig = applyQuickOverride(ctx.authorityEngine.getConfig(), {
            action: body.action,
            allow: body.allow,
            role_id: body.role_id,
          });
          ctx.authorityEngine.updateConfig(currentConfig);

          // Persist to config.yaml — same path as the full POST.
          const { loadConfig, saveConfig } = await import('../config/loader.ts');
          const freshConfig = await loadConfig();
          freshConfig.authority = {
            ...freshConfig.authority,
            overrides: currentConfig.overrides,
          };
          await saveConfig(freshConfig);

          return json({ ok: true, config: currentConfig });
        } catch (err) {
          return error(`quick-override failed: ${err instanceof Error ? err.message : String(err)}`);
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
        } catch (err) {
          return error('Invalid request body');
        }
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
      GET: async (req: Request & { params: { id: string } }) => {
        const capture = getCapture(req.params.id);
        if (!capture || !capture.image_path) return error('Image not found', 404);

        // Legacy rows (pre-Phase-7) have null sidecar_id and an image_path that
        // points to brain-local disk. Serve from there as a fallback.
        if (!capture.sidecar_id) {
          const jarvisDir = path.join(os.homedir(), '.jarvis');
          if (!isWithin(path.resolve(capture.image_path), path.resolve(jarvisDir))) {
            return error('Image not found', 404);
          }
          try {
            const imageData = readFileSync(capture.image_path);
            return new Response(new Uint8Array(imageData), {
              headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
            });
          } catch {
            return error('Image file not found on disk', 404);
          }
        }

        if (!ctx.sidecarManager) return error('Sidecar manager not available', 503);

        try {
          const result = await ctx.sidecarManager.dispatchRPC(
            capture.sidecar_id,
            'fetch_capture',
            { path: capture.image_path }
          ) as (Record<string, unknown> & { _binary?: { type?: string; data?: string } | Buffer }) | undefined;

          const binary = result?._binary;
          let imageData: Buffer | null = null;
          if (binary && typeof binary === 'object' && 'data' in binary && typeof binary.data === 'string') {
            imageData = Buffer.from(binary.data, 'base64');
          } else if (Buffer.isBuffer(binary)) {
            imageData = binary;
          }
          if (!imageData) return error('Image data unavailable', 502);

          return new Response(new Uint8Array(imageData), {
            headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' },
          });
        } catch (err) {
          console.error('[API] /captures/:id/image fetch_capture failed:', err instanceof Error ? err.message : err);
          return error('Image fetch failed', 502);
        }
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

    /**
     * Phase 6.4 — single-shot "create a workflow from this NL prompt".
     * Used by the Workflows Room voice action create_from_nl. Differs
     * from /nl-chat (which is conversational, chat-tab inside the editor)
     * by going through `parseDescription()` — purpose-built for "build a
     * full definition from this prompt", which writes nodes + edges in
     * one round-trip instead of biasing the LLM toward Q&A.
     *
     * Body: { name: string, description?: string, prompt: string }
     * Returns: { workflow: Workflow, version: WorkflowVersion }
     */
    '/api/workflows/nl-create': {
      POST: async (req: Request) => {
        if (!ctx.nlBuilder) return error('NL builder not available', 503);
        try {
          const body = await req.json() as {
            name?: string;
            description?: string;
            prompt?: string;
          };
          const prompt = (body.prompt ?? '').trim();
          if (!prompt) return error('prompt is required', 400);
          const name = (body.name ?? '').trim() || 'New workflow';

          // 1. Parse the NL into a full definition.
          const definition = await ctx.nlBuilder.parseDescription(prompt);

          // 2. Create the workflow shell + persist the definition as v1.
          const wfModule = await import('../vault/workflows.ts');
          const workflow = wfModule.createWorkflow(name, {
            description: body.description ?? prompt,
          });
          const version = wfModule.createVersion(
            workflow.id,
            definition,
            'Created from NL prompt',
          );

          return json({ workflow, version });
        } catch (err) {
          return error(`NL create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
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
          const result = await ctx.sidecarManager.enrollSidecar(body.name);
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
