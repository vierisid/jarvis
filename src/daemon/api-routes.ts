/**
 * REST API Routes
 *
 * Thin handlers over vault functions and daemon services.
 * Returns a routes object for Bun.serve().
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HealthMonitor } from './health.ts';
import { applyApprovalDecision } from './approval-decision.ts';
import { SecretStorageError } from './section-secrets.ts';
import type { AgentService } from './agent-service.ts';
import type { JarvisConfig } from '../config/types.ts';
import { realtimeServedByPlan, resolveRealtimeVoice, DEFAULT_BLOCKED_CATEGORIES } from '../config/realtime.ts';
import { hasUsejarvisAi, effectiveSttForBinding, effectiveTtsForBinding, realtimeEnablement, usejarvisVoiceCredentials } from './usejarvis-ai.ts';
import { cachedRealtimeVerdict } from './realtime-gate.ts';
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
import { listFlows } from '../workflows/db/repos/flow.ts';
import { getFlowVersion, getLatestDraft } from '../workflows/db/repos/flow-version.ts';

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
import type { AsyncTask } from '../agents/task-manager.ts';

import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isWithin } from '../util/path.ts';
import { externalUrl, resolveExternalOrigin } from '../util/external-origin.ts';
import { GoogleOAuthFlowStore } from '../integrations/google-oauth-flow.ts';

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
  /**
   * Where the Google tokens live. Only set by tests.
   *
   * GoogleAuth otherwise resolves this through os.homedir(), which Bun fixes at
   * process start and no test can redirect — so without this seam the Google
   * status endpoint reads whatever tokens the machine running the tests happens
   * to have, and its reconnect/authenticated branches cannot be exercised at all.
   */
  googleTokensPath?: string;
  wsService?: WebSocketService;
  channelService?: ChannelService;
  authorityEngine?: AuthorityEngine;
  approvalManager?: ApprovalManager;
  auditTrail?: AuditTrail;
  learner?: AuthorityLearner;
  emergencyController?: EmergencyController;
  deferredExecutor?: DeferredExecutor;
  awarenessService?: AwarenessService | null;
  // (legacy workflow engine fields removed; the new runtime is wired
  //  outside this ApiContext via createWorkflowRoutes in daemon/index.ts)
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
  /**
   * Settings hot reload coordinator. Wired by the daemon at boot; runs
   * per-section appliers so DB-backed settings (channels, STT, Google
   * observers, ...) apply to the running process without a restart.
   */
  settingsReload?: import('./settings-reload.ts').SettingsReloadCoordinator;
  /**
   * Observer service, for the hosted push bridge's doorbell to poll on demand.
   * Absent when observers are not running, which the webhook reports honestly
   * rather than pretending to have synced.
   */
  observerService?: { syncNow(source: 'gmail' | 'calendar'): Promise<string[]> };
};

/**
 * How far out of date a push doorbell may be. Generous, because it is bounded by
 * Pub/Sub's retry window and clock skew between two machines, not by anything
 * precise — the point is to reject a captured notification replayed hours later,
 * not to police seconds.
 */
const NOTIFY_MAX_SKEW_MS = 5 * 60 * 1000;

// CORS headers — scoped to the dashboard origin, not wildcard
let CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'http://localhost:3142',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Call once during init to set the correct CORS origin from config */
export function setCorsOrigin(origin: string) {
  CORS = {
    'Access-Control-Allow-Origin': origin.replace(/\/+$/, ''),
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

/**
 * Failure path shared by the config POST handlers. A malformed body is the
 * caller's fault (400), but a credential the keychain refused is ours: the
 * setting genuinely did not persist, and reporting that as "Invalid request
 * body" would send the user hunting for a typo in a valid request.
 */
function configSaveError(context: string, err: unknown): Response {
  console.error(`[API] ${context}:`, err);
  if (err instanceof SecretStorageError) {
    return json({ ok: false, message: err.message }, 500);
  }
  return error('Invalid request body');
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
  result?: {
    success: boolean;
    response: string;
    toolsUsed: string[];
    terminationReason: string;
  } | null;
};

/** List payloads cap the response so the 5s roster poll never ships a
 *  full research report per agent; /api/agents/tasks/:id returns it
 *  whole and the UI fetches that on expand when `response_truncated`. */
const LIST_RESPONSE_MAX_CHARS = 2000;

/** Serialize a task (with its result, when finished) for API responses.
 *  The result is the ONLY place the sub-agent's final answer lives for
 *  dashboard-spawned tasks -- without it the UI could show that a task
 *  completed but never what it produced. */
function taskToJSON(task: AgentTaskSnapshot, opts: { full?: boolean } = {}) {
  const response = task.result?.response ?? '';
  const truncate = !opts.full && response.length > LIST_RESPONSE_MAX_CHARS;
  return {
    id: task.id,
    status: task.status,
    task: task.task,
    started_at: task.startedAt,
    completed_at: task.completedAt ?? null,
    result: task.result
      ? {
          success: task.result.success,
          response: truncate ? response.slice(0, LIST_RESPONSE_MAX_CHARS) : response,
          response_truncated: truncate,
          tools_used: task.result.toolsUsed,
          termination_reason: task.result.terminationReason,
        }
      : null,
  };
}

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
      latest_task: latestTask ? taskToJSON(latestTask) : null,
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
  const googleOAuthFlows = new GoogleOAuthFlowStore();
  return {
    // --- Health ---
    '/api/health': {
      GET: () => json(ctx.healthMonitor.getHealth()),
    },

    '/api/system/external-origin': {
      GET: (req: Request) => {
        const resolved = resolveExternalOrigin(ctx.config, req);
        return json({
          public_origin: resolved.httpOrigin,
          websocket_origin: resolved.wsOrigin,
          source: resolved.source,
          proxy_detected: resolved.proxyDetected,
          google_callback: externalUrl(resolved, '/api/auth/google/callback'),
          warnings: resolved.warnings,
        });
      },
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
            // Dashboard-spawned tasks used to run with NO progress callback:
            // nothing streamed to the live ticker, nothing persisted to the
            // activity timeline, and the user never learned the task had
            // finished (let alone what it produced). Mirror the wiring the
            // PA's manage_agents tool gets at boot.
            onProgress: (event: { type: 'text' | 'tool_call' | 'done'; agentName: string; agentId: string; data: unknown }) => {
              ctx.wsService?.broadcastSubAgentProgress(event);
            },
            // The completion notification hangs off onTaskComplete, NOT the
            // 'done' progress event: 'done' only fires on the success path
            // inside runSubAgent, so a failed task would never notify at
            // all -- and it carries no success flag to word the message by.
            onTaskComplete: (task: AsyncTask) => {
              const ok = task.result?.success ?? false;
              ctx.wsService?.broadcastNotification(
                ok
                  ? `**${task.agentName} finished its task.** Open the Agents room to read the result.`
                  : `**${task.agentName} could not complete its task.** Open the Agents room for details.`,
                'normal',
              );
            },
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
            latest_task: latestTask ? taskToJSON(latestTask) : null,
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

    // Full detail for a single async task. Returns the response whole (the
    // agents room fetches it on expand when `response_truncated` is set) and
    // also flattens the fields the sub-pebble's "open full" panel
    // (taskResult room) renders directly.
    '/api/agents/tasks/:id': {
      GET: (req: Request & { params: { id: string } }) => {
        const tm = ctx.agentService.getTaskManager();
        if (!tm) return error('Persistent agents are not available.', 503);
        const task = tm.getTask(req.params.id);
        if (!task) return error(`Task "${req.params.id}" not found.`, 404);
        const elapsedS = Math.round(((task.completedAt ?? Date.now()) - task.startedAt) / 1000);
        return json({
          ...taskToJSON(task, { full: true }),
          agent_id: task.agentId,
          agent_name: task.agentName,
          specialist_id: task.specialistId,
          // Flat fields consumed by the taskResult room panel.
          specialist: task.specialistId,
          elapsed_seconds: elapsedS,
          response: task.result?.response ?? '',
          summary: task.summary,
          tools_used: task.result?.toolsUsed ?? [],
          tokens_used: task.result?.tokensUsed ?? null,
        });
      },
    },

    // Pebble long-answer panel — when a JARVIS response overflows the
    // speaking bubble, the daemon registers it in the answer store and
    // the sidecar shows an "open full ↗" button. Click spawns a panel
    // at `#/_answer_<id>` which fetches from this endpoint.
    '/api/pebble/answers/:id': {
      GET: async (req: Request) => {
        const { pebbleAnswerStore } = await import('./answer-store.ts');
        const url = new URL(req.url);
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (!id) return error('Missing answer id', 400);
        const record = pebbleAnswerStore.get(id);
        if (!record) return error(`Answer ${id} not found`, 404);
        return json(record);
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
          // ctx.config is the live, DB-merged config; loadConfig() would
          // return defaults here since onboarding is a user-owned section
          // that the file no longer carries.
          const o = ctx.config.onboarding;
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

          const { saveUserSection } = await import('./user-settings.ts');
          const fresh = ctx.config;
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
          saveUserSection('onboarding', fresh.onboarding);

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
     * Skip the ENTIRE onboarding flow from the first setup screen. No LLM
     * is configured, so the daemon stays chat-less until the user wires a
     * provider up in Settings → LLM — but the dashboard becomes reachable
     * immediately. Marks setup complete, opts out of the profile
     * interview, and dismisses the tutorial in one write. Existing
     * timestamps are preserved so a skip after a partial run never
     * regresses state.
     */
    '/api/onboarding/skip': {
      POST: async () => {
        try {
          const { saveUserSection } = await import('./user-settings.ts');
          const fresh = ctx.config;
          const now = Date.now();
          fresh.onboarding = {
            ...fresh.onboarding,
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? now,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            tutorial_dismissed_at: fresh.onboarding?.tutorial_dismissed_at ?? now,
            setup_skipped_profile: true,
          };
          saveUserSection('onboarding', fresh.onboarding);
          ctx.config.onboarding = fresh.onboarding;

          // Best-effort service start so the "Restart Jarvis" banner
          // doesn't nag after a skip. Failure is non-fatal — services
          // that need an LLM just stay idle until one is configured.
          let postSetupStarted = false;
          if (ctx.startPostSetupServices) {
            try {
              await ctx.startPostSetupServices();
              postSetupStarted = true;
            } catch (err) {
              console.warn(
                '[Onboarding] Post-setup services skipped after onboarding skip:',
                err instanceof Error ? err.message : err,
              );
            }
          }

          return json({
            ok: true,
            setup_completed_at: fresh.onboarding.setup_completed_at,
            post_setup_services_started: postSetupStarted,
            message: 'Onboarding skipped. Configure an LLM in Settings to start chatting.',
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
          const { saveUserSection } = await import('./user-settings.ts');
          const fresh = ctx.config;
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            ...fresh.onboarding,
            setup_skipped_profile: true,
          };
          saveUserSection('onboarding', fresh.onboarding);
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
    // the same mutate-then-saveUserSection pattern as the rest
    // of the onboarding routes; the existing reset endpoint with
    // `scope: "tutorial"` already clears all three fields.

    '/api/onboarding/tutorial/complete': {
      POST: async () => {
        try {
          const { saveUserSection } = await import('./user-settings.ts');
          const fresh = ctx.config;
          const now = Date.now();
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            ...fresh.onboarding,
            tutorial_completed_at: now,
            tutorial_progress_step: undefined,
          };
          saveUserSection('onboarding', fresh.onboarding);
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
          const { saveUserSection } = await import('./user-settings.ts');
          const fresh = ctx.config;
          const now = Date.now();
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            ...fresh.onboarding,
            tutorial_dismissed_at: now,
          };
          saveUserSection('onboarding', fresh.onboarding);
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
          const { saveUserSection } = await import('./user-settings.ts');
          const fresh = ctx.config;
          fresh.onboarding = {
            setup_completed_at: fresh.onboarding?.setup_completed_at ?? null,
            tutorial_completed_at: fresh.onboarding?.tutorial_completed_at ?? null,
            ...fresh.onboarding,
            tutorial_progress_step: stepId,
          };
          saveUserSection('onboarding', fresh.onboarding);
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
     * Atomic Phase A setup endpoint. Saves LLM + STT + TTS config + flips
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
     *     stt: {
     *       provider: "openai" | "groq" | "local" | "sarvam",
     *       openai?:  { api_key?: string, model?: string },
     *       groq?:    { api_key?: string, model?: string },
     *       sarvam?:  { api_key?: string, model?: string, language?: string },
     *       local?:   { endpoint: string, model?: string,
     *                   server_type?: "whisper_cpp" | "openai_compatible" },
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
     * Each field is optional; missing means "use current/default". The TTS
     * block is required to be present (even if just `{enabled:false}`) so
     * the user explicitly chose during the setup screen; STT is fully
     * optional (omit when the user picks "skip"). Sub-blocks are merged
     * via the shared mergeSTTConfig/mergeTTSConfig helpers so existing
     * api_keys are preserved when the patch omits them.
     */
    '/api/onboarding/setup': {
      POST: async (req: Request) => {
        try {
          const body = (await req.json()) as {
            llm?: Record<string, unknown>;
            stt?: Record<string, unknown>;
            tts?: Record<string, unknown>;
          };

          // 0. Hosted installs answer LLM/STT/TTS from the platform, so the
          //    wizard hides those steps and sends no provider config. Enforce
          //    that HERE rather than trusting the client: a stale cached
          //    bundle, a replayed request, or curl would otherwise pin the
          //    account off its own plan — writing llm.default (which makes
          //    effectiveLlmForBinding bail out and disables all four uj-*
          //    tiers) or tts.provider (which marks the user as having chosen,
          //    so the included voice never applies again).
          //
          //    `mode` is the one LLM field a hosted install may set: it
          //    records the architecture choice without naming a provider or a
          //    model, and without it the settings tab misreports multi-tier
          //    as single. Everything else is dropped.
          //    `tts.enabled` is likewise kept: whether the assistant SPEAKS is
          //    not a provider choice, and dropping it would leave a hosted
          //    install mute (DEFAULT_CONFIG has it false) while the wizard
          //    promises the plan includes voice. The provider field is still
          //    stripped, so the row stays silent and the included uj voice
          //    applies.
          // Whatever the guard strips is REPORTED back (`dropped`): a wizard
          // that raced the hosted probe may have collected provider config
          // the guard is about to discard — answering plain ok would let it
          // print "✓ brain · Anthropic" for credentials that were never
          // saved (review pr7#4).
          const dropped: string[] = [];
          if (hasUsejarvisAi(ctx.config)) {
            const llmBody = body.llm as { mode?: unknown; providers?: unknown; default?: unknown } | undefined;
            const mode = llmBody?.mode;
            if (llmBody && (llmBody.providers !== undefined || llmBody.default !== undefined)) dropped.push('llm');
            body.llm = mode === 'single' || mode === 'multi-tier' ? { mode } : undefined;
            if (body.stt !== undefined) dropped.push('stt');
            body.stt = undefined;
            const ttsBody = body.tts as { enabled?: unknown; provider?: unknown } | undefined;
            if (ttsBody && Object.keys(ttsBody).some((k) => k !== 'enabled')) dropped.push('tts');
            const enabled = ttsBody?.enabled;
            body.tts = typeof enabled === 'boolean' ? { enabled } : undefined;
          }

          // 1. LLM settings — same path as /api/config/llm POST.
          if (body.llm && Object.keys(body.llm).length > 0) {
            const { saveLLMSettings, hotReloadLLMProviders } = await import('./llm-settings.ts');
            saveLLMSettings(ctx.config, body.llm as any);
            hotReloadLLMProviders(ctx.config, ctx.agentService.getLLMManager());
          }

          // 2. STT + TTS + the setup-completed flag in ONE config write.
          //    These used to be three sequential load→save round-trips; a
          //    daemon kill (or crash) between them persisted setup HALF-done
          //    — TTS saved but the completion flag lost — and the user was
          //    funneled back into onboarding on the next boot.
          const { saveUserSection, persistUserPatch } = await import('./user-settings.ts');
          const { mergeSTTConfig, mergeTTSConfig } = await import('./config-merge.ts');
          // Everything is merged into LOCALS and published to ctx.config only
          // after all three saves succeeded. saveUserSection throws when the
          // keychain refuses a key, and a half-published config would leave the
          // running daemon reporting setup as complete (GET /api/onboarding/
          // status reads ctx.config) with no key stored.
          const stt = body.stt ? mergeSTTConfig(ctx.config.stt, body.stt) : undefined;
          const tts = body.tts ? mergeTTSConfig(ctx.config.tts, body.tts) : undefined;
          const now = Date.now();
          const onboarding = {
            setup_completed_at: now,
            tutorial_completed_at: ctx.config.onboarding?.tutorial_completed_at ?? null,
            setup_skipped_profile: ctx.config.onboarding?.setup_skipped_profile,
            tutorial_dismissed_at: ctx.config.onboarding?.tutorial_dismissed_at,
            tutorial_progress_step: ctx.config.onboarding?.tutorial_progress_step,
            last_reset_at: ctx.config.onboarding?.last_reset_at,
          };
          // Credential-bearing sections first, the completion flag LAST: a
          // keychain failure throws out of here, and the flag not being written
          // is what we want — setup did not succeed, so the wizard must run
          // again rather than leave the user with a "done" marker and no key.
          //
          // Persist the wizard's PATCHES over the stored rows (not the merged
          // sections): a declined voice step ({enabled:false} with no
          // provider) must not stamp the DEFAULT provider into the row, or
          // every onboarded hosted install would read as "explicitly chose
          // Edge" and never get the included Usejarvis AI default.
          if (body.stt) persistUserPatch('stt', body.stt);
          if (body.tts) persistUserPatch('tts', body.tts);
          saveUserSection('onboarding', onboarding);
          if (stt) ctx.config.stt = stt;
          if (tts) ctx.config.tts = tts;
          ctx.config.onboarding = onboarding;

          // 3. Hot-reload the TTS provider when possible so the post-setup
          //    "Welcome to Jarvis" reply is spoken immediately.
          if (body.tts) {
            try {
              if (ctx.config.tts && ctx.wsService) {
                const { createTTSProvider } = await import('../comms/voice.ts');
                const ttsBinding = effectiveTtsForBinding(ctx.config) ?? ctx.config.tts;
                const provider = createTTSProvider(ttsBinding, usejarvisVoiceCredentials(ctx.config));
                if (provider) ctx.wsService.setTTSProvider(provider);
              }
            } catch (err) {
              console.warn('[Onboarding] TTS hot-reload skipped:', err);
            }
          }

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
            // Sections the hosted guard stripped from this request, so the
            // wizard can tell the user instead of claiming they were saved.
            dropped,
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
          // LLM config is DB/keychain-managed (dashboard). Report a sanitized
          // canonical summary - provider names, single-LLM default, and the
          // tier map. The dedicated dashboard endpoint is /api/config/llm.
          llm: {
            // Hosted installs: hide the injected reserved provider, matching
            // getLLMSettings — a client that round-trips this list into a
            // save would hit the managed-provider 400 (pr2 review #9).
            providers: Object.keys(config.llm.providers ?? {}).filter(
              (name) => name !== 'usejarvis_ai' || !hasUsejarvisAi(config),
            ),
            default: config.llm.default ?? null,
            tiers: config.llm.tiers ?? {},
          },
          personality: config.personality,
          authority: config.authority,
          heartbeat: config.heartbeat,
          active_role: config.active_role,
          voice: config.voice ?? { wake_engine: 'openwakeword' },
        });
      },
    },

    // Force a full re-read of the DB-backed settings into the running
    // daemon. Covers edits made outside the process (sqlite3 CLI, another
    // tool); same path as SIGHUP. In-process saves don't need this — the
    // saveUserSection choke point already runs the appliers.
    '/api/config/reload': {
      POST: async () => {
        if (!ctx.settingsReload) return error('Settings hot reload not available', 503);
        try {
          const result = await ctx.settingsReload.reloadAll();
          return json({ ok: result.errors.length === 0, ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(`Settings reload failed: ${msg}`, 500);
        }
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
          const body = await req.json() as {
            name?: string;
            provider?: string;
            kind?: import('../config/types.ts').LLMProviderKind;
            api_key?: string;
            model?: string;
            base_url?: string;
            auth_header?: string;
          };
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
          // Key (if any) lives in the keychain, keyed by provider name. NVIDIA's
          // /v1/models is publicly readable, so an empty key still works.
          const { getSecret } = await import('../vault/keychain.ts');
          const key = getSecret('llm.provider.nvidia.api_key') ?? '';
          const provider = new NVIDIAProvider(key);
          const models = await provider.listModels();
          return json({ ok: true, models });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ ok: false, error: msg, models: [] });
        }
      },
    },

    // Live model catalog for Ollama. Unlike the cloud providers, an Ollama
    // install only serves the models the operator actually pulled, and every
    // one of them carries a tag ("qwen2.5:3b"). A curated list can only ever
    // guess, and a guessed *untagged* id ("qwen2.5") resolves to ":latest",
    // which is typically NOT pulled -> `model not found` at first chat.
    // Ask the server instead. `base_url` is a query param because onboarding
    // tests a URL the user has typed but not saved yet; it falls back to the
    // configured entry, then to the default endpoint.
    '/api/config/llm/ollama/models': {
      GET: async (req: Request) => {
        try {
          const { OllamaProvider } = await import('../llm/ollama.ts');
          const typed = new URL(req.url).searchParams.get('base_url')?.trim();
          if (typed && !/^https?:\/\//i.test(typed)) {
            return json({ ok: false, error: 'base_url must be an http(s) URL', models: [] });
          }
          const configured = Object.values(ctx.config.llm.providers ?? {})
            .find((e) => e?.kind === 'ollama')?.base_url;
          const baseUrl = typed || configured || 'http://localhost:11434';
          const models = await new OllamaProvider(baseUrl).listModels();
          return json({ ok: true, models });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ ok: false, error: msg, models: [] });
        }
      },
    },

    // Live Usejarvis AI catalog: the uj-* aliases THIS account's key may
    // call (the proxy filters per key, so there is no hardcoded list). The
    // provider is built from the system-owned config.yaml block — the route
    // takes no credentials and never echoes the base_url or key back.
    /**
     * This instance's hosted usage meter — % of each window used and when they
     * reset (docs/LLM.md on the control plane, "Windows + meters").
     *
     * Hosted-only, like its neighbour below: a self-hosted install has no key,
     * no plan and no windows, so 503 is the honest answer rather than zeros.
     *
     * Degrades to `{ ok: false }` rather than throwing, and never carries the
     * upstream body — the control-plane host is withheld here for the same
     * reason the catalog route withholds the proxy's.
     */
    '/api/llm/budget': {
      GET: async () => {
        const { hasUsejarvisAi } = await import('./usejarvis-ai.ts');
        if (!hasUsejarvisAi(ctx.config)) {
          return error('The usage meter is only available on hosted installs.', 503);
        }
        const { readHostedUsage } = await import('./hosted-usage.ts');
        const meter = await readHostedUsage(ctx.config);
        return meter
          ? json({ ok: true, meter })
          : json({ ok: false, error: 'Usage is unavailable right now' });
      },
    },

    '/api/config/llm/usejarvis/models': {
      GET: async () => {
        const { hasUsejarvisAi } = await import('./usejarvis-ai.ts');
        if (!hasUsejarvisAi(ctx.config)) {
          return error('Usejarvis AI is only available on hosted installs.', 503);
        }
        try {
          const { UsejarvisAIProvider } = await import('../llm/usejarvis.ts');
          const { noteHostedCatalog } = await import('./usejarvis-ai.ts');
          const block = ctx.config.usejarvis_ai!;
          const provider = new UsejarvisAIProvider(block.base_url!.trim(), block.api_key!.trim());
          const { models, degraded } = await provider.listModelsDetailed();
          // A live catalog feeds the save-time allowlist; a degraded one never
          // does (it would shrink the allowlist to the fallback four). The
          // flag lets the dashboard show "plan catalog unreachable — Retry"
          // instead of presenting the fallback as the plan's truth.
          noteHostedCatalog(models, degraded);
          return json({ ok: true, models, degraded });
        } catch (err) {
          // listModels embeds the upstream response body in its errors, and a
          // CDN/proxy error page can echo the hosted base_url hostname this
          // surface deliberately hides — the detail stays in the server log.
          console.warn(
            '[LLM] Usejarvis AI catalog fetch failed:',
            err instanceof Error ? err.message : err,
          );
          return json({ ok: false, error: 'Usejarvis AI catalog unavailable', models: [] });
        }
      },
    },

    // Full OmniRoute catalog: provider models, free routes, automatic routes,
    // and user-defined combos. POST keeps an onboarding API key out of the URL
    // and also supports a saved provider by name from Settings.
    '/api/config/llm/omniroute/models': {
      POST: async (req: Request) => {
        try {
          const body = await req.json() as {
            name?: string;
            base_url?: string;
            api_key?: string;
          };
          // Effective kind is `entry.kind ?? name` (see config-binding.ts) -
          // a provider simply named "omniroute" counts too.
          const providers = ctx.config.llm.providers ?? {};
          const providerName = body.name
            ?? Object.keys(providers).find((name) => (providers[name]?.kind ?? name) === 'omniroute');
          const configured = providerName ? providers[providerName] : undefined;
          if (body.name && (!configured || (configured.kind ?? body.name) !== 'omniroute')) {
            return json({ ok: false, error: 'OmniRoute provider not found', models: [] });
          }
          const requestedBaseUrl = body.base_url?.trim();
          const baseUrl = requestedBaseUrl || configured?.base_url?.trim() || 'http://localhost:20128/v1';
          if (!/^https?:\/\//i.test(baseUrl)) {
            return json({ ok: false, error: 'base_url must be an http(s) URL', models: [] });
          }

          // Saved credentials only travel to the saved base URL - a caller-typed
          // base_url never gets the stored key attached.
          const { getSecret } = await import('../vault/keychain.ts');
          const storedApiKey = requestedBaseUrl
            ? null
            : (providerName ? getSecret(`llm.provider.${providerName}.api_key`) : null) || configured?.api_key;
          const apiKey = body.api_key || storedApiKey || '';
          const { OmniRouteProvider } = await import('../llm/omniroute.ts');
          const models = await new OmniRouteProvider(baseUrl, 'auto', apiKey).listModels();
          return json({ ok: true, models });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ ok: false, error: msg, models: [] });
        }
      },
    },

    // Keep Groq's changing model catalog out of hard-coded UI lists.
    '/api/config/llm/groq/models': {
      POST: async (req: Request) => {
        try {
          const body = await req.json() as { name?: string; api_key?: string };
          const providers = ctx.config.llm.providers ?? {};
          const providerName = body.name
            ?? Object.keys(providers).find((name) => (providers[name]?.kind ?? name) === 'groq');
          const configured = providerName ? providers[providerName] : undefined;
          if (body.name && (!configured || (configured.kind ?? body.name) !== 'groq')) {
            return json({ ok: false, error: 'Groq provider not found', models: [] });
          }
          const { getSecret } = await import('../vault/keychain.ts');
          const apiKey = body.api_key
            || (providerName ? getSecret(`llm.provider.${providerName}.api_key`) : null)
            || configured?.api_key
            || '';
          if (!apiKey) return json({ ok: false, error: 'Groq API key required', models: [] });

          const { GroqProvider } = await import('../llm/groq.ts');
          const models = await new GroqProvider(apiKey).listModels();
          return json({ ok: true, models });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ ok: false, error: msg, models: [] });
        }
      },
    },

    // --- Usage telemetry ---
    /**
     * Filterable LLM usage query. All query params are optional:
     *   from, to        unix-ms range bounds (default: last 30 days -> now)
     *   tier            CSV: conversation,high,medium,low
     *   model           CSV
     *   subsystem       CSV
     *   provider        CSV
     *   errors_only     "true" | "false" | "" (both)
     *   group_by        tier | model | subsystem | provider | date | none
     *                   default: model
     */
    '/api/usage': {
      GET: async (req: Request) => {
        try {
          const { queryUsage } = await import('../llm/usage.ts');
          const url = new URL(req.url);
          const get = (k: string) => url.searchParams.get(k);

          const parseCsv = (v: string | null): string[] | undefined => {
            if (!v) return undefined;
            const list = v.split(',').map((s) => s.trim()).filter(Boolean);
            return list.length > 0 ? list : undefined;
          };
          const parseInt64 = (v: string | null): number | undefined => {
            if (!v) return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
          };
          const errorsOnlyRaw = get('errors_only');
          const errorsOnly = errorsOnlyRaw === 'true' ? true : errorsOnlyRaw === 'false' ? false : undefined;
          const groupByRaw = get('group_by') ?? 'model';
          const validGroups = ['tier', 'model', 'subsystem', 'provider', 'date', 'none'] as const;
          const groupBy = (validGroups as readonly string[]).includes(groupByRaw)
            ? (groupByRaw as typeof validGroups[number])
            : 'model';

          const result = queryUsage(
            {
              fromMs: parseInt64(get('from')),
              toMs: parseInt64(get('to')),
              tiers: parseCsv(get('tier')),
              models: parseCsv(get('model')),
              subsystems: parseCsv(get('subsystem')),
              providers: parseCsv(get('provider')),
              errorsOnly,
            },
            groupBy,
          );
          return json(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ error: msg, rows: [], total: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_latency_ms: 0, errors: 0 } });
        }
      },
    },

    /** Distinct filter values + date range present in the DB. Used by the
     *  Usage room to populate filter dropdowns with only-extant choices. */
    '/api/usage/filters': {
      GET: async () => {
        try {
          const { listUsageDistinctValues } = await import('../llm/usage.ts');
          return json(listUsageDistinctValues());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ error: msg, tiers: [], models: [], subsystems: [], providers: [], earliest_ts: null, latest_ts: null });
        }
      },
    },

    /**
     * Paused conv-tier tasks (status === 'needs_input'). Used by the dashboard
     * to surface pending questions after a daemon restart - durability lands
     * them back in the registry on boot, this endpoint makes them visible to
     * the user. The conv LLM separately picks them up via registry context.
     * Returns an empty list when running in classic mode (no task registry).
     */
    '/api/tasks/paused': {
      GET: () => {
        const registry = ctx.agentService.getTaskRegistry();
        if (!registry) return json({ tasks: [] });
        const tasks = registry.inFlight()
          .filter((t) => t.status === 'needs_input')
          .map((t) => ({
            id: t.id,
            template: t.request.template,
            intent: t.request.intent,
            question: t.question ?? '',
            started_at: t.startedAt,
            updated_at: t.updatedAt,
          }));
        return json({ tasks });
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
        const state = params.get('state');

        // A denial has nothing to protect and nothing to exchange — render it
        // before touching (and burning) the one-time state.
        if (authError) {
          return new Response(
            `<html><body><h1>Authorization Denied</h1><p>${escapeHtml(authError)}</p><p>You can close this tab.</p></body></html>`,
            { headers: { ...CORS, 'Content-Type': 'text/html' } }
          );
        }

        if (!code) {
          return error('Missing authorization code', 400);
        }

        // Top-level browser navigation: state failures get an HTML page, not JSON.
        const pendingFlow = state ? googleOAuthFlows.consume(state) : null;
        if (!pendingFlow) {
          const reason = state
            ? 'This authorization link was already used or has expired.'
            : 'This authorization link is missing its OAuth state.';
          return new Response(
            `<html><body><h1>Authorization Failed</h1><p>${reason}</p><p>Start Google authorization again from the Jarvis dashboard.</p></body></html>`,
            { headers: { ...CORS, 'Content-Type': 'text/html' }, status: 400 }
          );
        }

        // Try to exchange the code using GoogleAuth from context
        const googleConfig = ctx.config.google;
        if (!googleConfig?.client_id || !googleConfig?.client_secret) {
          return error('Google OAuth not configured in config.yaml', 500);
        }

        try {
          // Lazy import to avoid circular deps
          const { GoogleAuth } = await import('../integrations/google-auth.ts');
          const auth = new GoogleAuth(googleConfig.client_id, googleConfig.client_secret, {
            redirectUri: pendingFlow.redirectUri,
          });
          await auth.exchangeCode(code, { codeVerifier: pendingFlow.codeVerifier });

          // The exchange above used a throwaway GoogleAuth that saved the
          // tokens to disk; nudge the hot-reload applier so the daemon's
          // long-lived auth re-reads them and the observers start now
          // (no saveGoogleSettings fires here, so this is explicit).
          ctx.settingsReload?.sectionChanged('google');

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
        const { classifyGoogle, makeGoogleAuth } = await import(
          '../integrations/google-managed-refresh.ts'
        );
        const shape = classifyGoogle(ctx.config);
        // A MANAGED instance has no client credentials by design — the control
        // plane holds them and refreshes on its behalf — so "configured" cannot
        // mean "has credentials" any more, or hosted would always read as
        // not_configured.
        const configured = shape.mode !== 'none';
        // Control-plane managed (GOOGLE.md): the settings UI must show the hosted
        // Connect button instead of the credentials form, because the account is
        // connected THROUGH the control plane and this daemon's own OAuth flow
        // cannot work here.
        //
        // From the CLASSIFIER, not from connect_url. Keyed on connect_url alone
        // this disagreed with `configured` whenever a config had refresh_url and
        // no connect_url: the instance was managed, refresh and the doorbell
        // worked, and the tab still rendered the credentials form — whose save
        // then 409s from the managed guard and whose OAuth button 400s. The
        // control plane now refuses to boot without the link, and this reads the
        // same source of truth the auth builder does.
        const managed = shape.mode === 'managed';
        const managedFields = managed
          ? { managed: true as const, connect_url: googleConfig?.connect_url ?? null }
          : { managed: false as const };

        if (!configured) {
          return json({
            status: 'not_configured',
            configured: false,
            is_authenticated: false,
            scopes: [],
            token_expiry: null,
            // A config we REFUSED says why; "no Google here" says nothing.
            ...(shape.reason ? { reason: shape.reason } : {}),
            ...managedFields,
          });
        }

        try {
          const auth = makeGoogleAuth(ctx.config, undefined, ctx.googleTokensPath);
          const tokens = auth?.loadTokens() ?? null;
          // A revoked or expired grant leaves the tokens file exactly where it
          // was, so "we have tokens" is not "Google works". When the grant is
          // known to be gone, report NOT authenticated — that is what puts the
          // Connect button back in front of the user instead of a green
          // "connected" chip over a dead integration.
          const reconnect = auth?.reconnectRequired() ?? null;
          const authenticated = !reconnect && (auth?.isAuthenticated() ?? false);

          return json({
            // Managed and not yet authenticated is "waiting for the control
            // plane to deliver", not "save your credentials" — there are none to
            // save here.
            status: reconnect
              ? 'reconnect_required'
              : authenticated
                ? 'connected'
                : managed
                  ? 'not_connected'
                  : 'credentials_saved',
            configured: true,
            is_authenticated: authenticated,
            ...(reconnect ? { reconnect_reason: reconnect } : {}),
            scopes: ['gmail.readonly', 'calendar.readonly'],
            token_expiry: tokens?.expiry_date ?? null,
            ...managedFields,
          });
        } catch {
          // managedFields is carried here too: dropping it answered
          // `credentials_saved` with no `managed`, i.e. the self-hosted
          // credentials form on a hosted box — the same wrong UI as above.
          return json({
            status: managed ? 'not_connected' : 'credentials_saved',
            configured: true,
            is_authenticated: false,
            scopes: [],
            token_expiry: null,
            ...managedFields,
          });
        }
      },
    },

    '/api/config/google': {
      POST: async (req: Request) => {
        try {
          // MANAGED instances must not accept credentials here (GOOGLE.md).
          // The sibling /api/auth/google/init already refuses; this one did not,
          // and it REPLACES the whole google section — so one POST from a stale
          // tab or a curl dropped refresh_url, instance_id and notify_secret
          // from the running config and persisted a row that then won on every
          // reload: refresh dead, doorbell 404, managed UI gone. Silently.
          const { classifyGoogle } = await import('../integrations/google-managed-refresh.ts');
          if (classifyGoogle(ctx.config).mode === 'managed' || ctx.config.google?.refresh_url) {
            return error(
              'This instance is managed by usejarvis — its Google credentials are held by the control plane and cannot be set here.',
              409,
            );
          }
          const body = await req.json() as { client_id: string; client_secret: string };
          if (!body.client_id || !body.client_secret) {
            return error('Missing client_id or client_secret');
          }

          const freshConfig = ctx.config;
          freshConfig.google = { client_id: body.client_id, client_secret: body.client_secret };
          const { saveGoogleSettings } = await import('./user-settings.ts');
          saveGoogleSettings(freshConfig.google);

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
        // MANAGED instances must not run this flow (GOOGLE.md). Its redirect URI
        // is this instance's own hostname, which is not registered with Google —
        // there is exactly ONE registered URI, on the control plane, precisely so
        // that moving to another host does not break it. Starting the flow here
        // therefore ends at a redirect_uri_mismatch error page, so it is refused
        // at the API rather than only hidden in the UI.
        if (googleConfig?.connect_url) {
          return error(
            `This instance is managed by usejarvis — connect Google from ${googleConfig.connect_url}`,
            409,
          );
        }
        if (!googleConfig?.client_id || !googleConfig?.client_secret) {
          return error('Google credentials not configured. Save client_id and client_secret first.', 400);
        }

        try {
          const { GoogleAuth } = await import('../integrations/google-auth.ts');
          const externalOrigin = resolveExternalOrigin(ctx.config);
          const redirectUri = externalUrl(externalOrigin, '/api/auth/google/callback');
          const flow = googleOAuthFlows.start(redirectUri);
          const auth = new GoogleAuth(googleConfig.client_id, googleConfig.client_secret, { redirectUri });
          const scopes = [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/calendar.readonly',
          ];
          const authUrl = auth.getAuthUrl(scopes, {
            state: flow.state,
            codeChallenge: flow.codeChallenge,
          });
          return json({ auth_url: authUrl, redirect_uri: redirectUri });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(`Failed to generate auth URL: ${msg}`, 500);
        }
      },
    },


    /**
     * The push bridge's doorbell (GOOGLE.md "Push bridging"). HOSTED ONLY.
     *
     * PUBLIC route, deliberately, and it has to be: the caller is the control
     * plane, which holds no enrolled-device token and must not. It lives under
     * `/api/webhooks/` because that prefix is already the public, signature-
     * verified machine-to-machine surface (see isPublicRoute) — inventing a new
     * exception for one route would widen the unauthenticated surface for no
     * reason. Two path segments so it cannot be confused with the workflow
     * webhook ingress at `/api/webhooks/:flowId`.
     *
     * Authentication is the HMAC over the exact body, keyed by the per-instance
     * notify_secret from the system config. Constant-time compared: this is a MAC
     * check on attacker-supplied input, and a byte-by-byte early exit is what a
     * forgery attempt measures.
     *
     * The body is a DOORBELL — `{source, at}`, no data — so the worst a forged
     * one achieves is an early poll. That is why the answer is deliberately
     * uninformative about which instance or address exists.
     */
    '/api/webhooks/google/notify': {
      POST: async (req: Request) => {
        const secret = ctx.config.google?.notify_secret;
        // No secret configured = self-hosted, or a hosted instance whose config
        // predates the bridge. Nothing can be verified, so nothing is accepted.
        if (!secret) return error('not configured', 404);

        const raw = await req.text();
        const { INSTANCE_SIGNATURE_HEADER, verifyWithSecret } = await import(
          '../integrations/google-signature.ts'
        );
        // Byte-length compare, via the shared helper: the hand-rolled version
        // here gated on String.length, so a 64-CHARACTER non-ASCII signature got
        // past it and made timingSafeEqual throw — a 500 with a stack instead of
        // a 401, from any unauthenticated caller, on a deliberately public route.
        if (!verifyWithSecret(secret, raw, req.headers.get(INSTANCE_SIGNATURE_HEADER))) {
          return error('bad signature', 401);
        }

        let source: 'gmail' | 'calendar' | null = null;
        let at = 0;
        try {
          const body = JSON.parse(raw) as { source?: unknown; at?: unknown };
          if (body.source === 'gmail' || body.source === 'calendar') source = body.source;
          if (typeof body.at === 'string') at = Date.parse(body.at);
        } catch {
          return error('bad body', 400);
        }
        if (!source) return error('bad body', 400);
        // The timestamp is INSIDE the signed bytes, so a replayed doorbell can be
        // rejected without keeping a nonce store: an old one is either a retry
        // long past being useful or a capture being replayed, and the poll timer
        // covers anything genuinely missed.
        if (!Number.isFinite(at) || Math.abs(Date.now() - at) > NOTIFY_MAX_SKEW_MS) {
          return error('stale', 400);
        }

        if (!ctx.observerService) return json({ ok: true, synced: [] });
        const synced = await ctx.observerService.syncNow(source);
        return json({ ok: true, synced });
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
          // The google applier drops the daemon's in-memory tokens and
          // restarts the observers, so the disconnect takes effect now.
          if (!ctx.settingsReload) {
            return json({ ok: true, message: 'Disconnected. Restart to deactivate observers (hot reload unavailable).' });
          }
          const applyErr = await ctx.settingsReload.applyNow('google');
          if (applyErr) {
            return json({ ok: false, message: `Disconnected, but deactivating observers failed: ${applyErr.error}` });
          }
          return json({ ok: true, message: 'Disconnected. Google observers deactivated.' });
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
        // Binding view, like the /api/config/stt GET: after a provider reset
        // on a hosted install the raw section has no (or an empty sentinel)
        // provider while transcription runs happily on 'usejarvis' — the raw
        // read blanked the Channels header on a working install.
        const sttBinding = effectiveSttForBinding(ctx.config);
        return json({
          channels: ctx.channelService.getChannelStatus(),
          stt: sttBinding?.provider || ctx.config.stt?.provider || null,
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
          const { saveUserSection } = await import('./user-settings.ts');

          // Merge into a LOCAL copy: saveUserSection throws when the keychain
          // refuses the token, and mutating ctx.config first would leave the
          // running daemon holding a credential the API just reported as not
          // saved (GET would answer has_token: true) until the next restart.
          const merged: NonNullable<JarvisConfig['channels']> = { ...ctx.config.channels };
          if (body.telegram && typeof body.telegram === 'object') {
            merged.telegram = {
              ...merged.telegram,
              ...(body.telegram as Record<string, unknown>),
            } as any;
          }
          if (body.discord && typeof body.discord === 'object') {
            merged.discord = {
              ...merged.discord,
              ...(body.discord as Record<string, unknown>),
            } as any;
          }

          saveUserSection('channels', merged);
          ctx.config.channels = merged;

          if (!ctx.settingsReload) {
            return json({ ok: true, message: 'Channel config saved. Restart to apply (hot reload unavailable).' });
          }
          const applyErr = await ctx.settingsReload.applyNow('channels');
          if (applyErr) {
            return json({ ok: false, message: `Channel config saved, but applying it failed: ${applyErr.error}` });
          }
          return json({ ok: true, message: 'Channel config saved and applied.' });
        } catch (err) {
          return configSaveError('Error saving channels config', err);
        }
      },
    },

    '/api/config/stt': {
      GET: () => {
        const stt = ctx.config.stt;
        // `provider` reports the BINDING view: on hosted installs where the
        // user never chose, it reads 'usejarvis' (what actually transcribes)
        // while the persisted cfg.stt row stays untouched. No key material —
        // the hosted credentials live only in the system config.
        const effective = effectiveSttForBinding(ctx.config);
        return json({
          provider: effective?.provider ?? stt?.provider ?? 'openai',
          usejarvis_available: hasUsejarvisAi(ctx.config),
          // Empty string = auto-detect (the language param is omitted from
          // provider requests). Surfaced so hosted users — who have no shell
          // access to config.yaml — can change it from the dashboard.
          language: stt?.language ?? '',
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
          const { persistUserPatch, clearProviderChoice } = await import('./user-settings.ts');
          const { mergeSTTConfig } = await import('./config-merge.ts');

          // `provider: null` means "reset to the plan default": drop the
          // recorded choice so the row is silent again and
          // effectiveSttForBinding fills it with the included uj stack.
          // Writing 'usejarvis' instead would record a choice and pin them.
          // Runs BEFORE provider validation: null is a command, not a
          // provider value. Hosted only: on a self-hosted install there is no
          // plan default to fall back TO, so clearing the choice would leave
          // createSTTProvider with nothing to build and silently kill
          // transcription.
          if (body.provider === null) {
            if (!hasUsejarvisAi(ctx.config)) {
              return error('No plan default to reset to on a self-hosted install');
            }
            const cleared = clearProviderChoice('stt');
            if (!cleared) {
              return json({ ok: true, message: 'Nothing to reset — no transcription choice is recorded, so your plan default already applies.' });
            }
            if (ctx.config.stt) delete (ctx.config.stt as Record<string, unknown>).provider;
            if (!ctx.settingsReload) {
              return json({ ok: true, message: 'Reset to your plan default. Restart to apply.' });
            }
            const resetErr = await ctx.settingsReload.applyNow('stt');
            return json(resetErr
              ? { ok: false, message: `Reset saved, but applying it failed: ${resetErr.error}` }
              : { ok: true, message: 'Reset to your plan default.' });
          }

          // Validate before anything persists: an unknown provider (or
          // 'usejarvis' on a self-hosted install, where createSTTProvider can
          // never construct it) previously saved fine and answered ok:true —
          // then STT was silently dead on every surface with only a console
          // line to show for it.
          const STT_PROVIDERS = ['openai', 'groq', 'local', 'sarvam', 'usejarvis'];
          if (body.provider !== undefined) {
            if (typeof body.provider !== 'string' || !STT_PROVIDERS.includes(body.provider)) {
              return json({ ok: false, message: `Unknown STT provider: ${String(body.provider)}` }, 400);
            }
            if (body.provider === 'usejarvis' && !hasUsejarvisAi(ctx.config)) {
              return json({ ok: false, message: 'Usejarvis AI transcription is only available on hosted installs.' }, 400);
            }
          }
          // The hosted credentials never live in cfg.stt — a 'usejarvis'
          // sub-block in the patch would persist a key into the plaintext
          // settings row, the exact leak the credential split exists to stop.
          delete body.usejarvis;

          // Merged locally and published only once the save succeeded (a
          // throwing keychain must not leave the live config holding a key the
          // API reported as rejected), but what gets PERSISTED is the request
          // patch, not the merged section: the merge carries DEFAULT_CONFIG
          // fills, and storing those would stamp a provider choice the user
          // never made and permanently defeat the hosted-default silence
          // detection. Appliers run on a scheduled tick, so they observe the
          // published config below rather than this frame.
          const merged = mergeSTTConfig(ctx.config.stt, body);
          persistUserPatch('stt', body);
          ctx.config.stt = merged;

          if (!ctx.settingsReload) {
            return json({ ok: true, message: 'STT config saved. Restart to apply (hot reload unavailable).' });
          }
          const applyErr = await ctx.settingsReload.applyNow('stt');
          if (applyErr) {
            return json({ ok: false, message: `STT config saved, but applying it failed: ${applyErr.error}` });
          }
          return json({ ok: true, message: 'STT config saved and applied.' });
        } catch (err) {
          return configSaveError('Error saving STT config', err);
        }
      },
    },

    '/api/config/tts': {
      GET: () => {
        const tts = ctx.config.tts;
        // Same shape as GET /api/config/stt: `provider` is the BINDING view
        // (hosted installs with no recorded choice read 'usejarvis'), the
        // persisted cfg.tts row stays pure user intent, no key material.
        const effective = effectiveTtsForBinding(ctx.config);
        return json({
          enabled: tts?.enabled ?? false,
          provider: effective?.provider ?? tts?.provider ?? 'edge',
          usejarvis_available: hasUsejarvisAi(ctx.config),
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
          const { persistUserPatch, clearProviderChoice } = await import('./user-settings.ts');

          // `provider: null` resets to the plan default, mirroring the STT
          // route: a command, handled before provider validation.
          if (body.provider === null) {
            if (!hasUsejarvisAi(ctx.config)) {
              return error('No plan default to reset to on a self-hosted install');
            }
            const cleared = clearProviderChoice('tts');
            if (!cleared) {
              return json({ ok: true, message: 'Nothing to reset — no voice choice is recorded, so your plan default already applies.' });
            }
            if (ctx.config.tts) delete (ctx.config.tts as Record<string, unknown>).provider;
            if (!ctx.settingsReload) {
              return json({ ok: true, message: 'Reset to your plan default. Restart to apply.' });
            }
            const resetErr = await ctx.settingsReload.applyNow('tts');
            return json(resetErr
              ? { ok: false, message: `Reset saved, but applying it failed: ${resetErr.error}` }
              : { ok: true, message: 'Reset to your plan default.' });
          }

          // Validate the provider before anything persists: an unknown string
          // (or 'usejarvis' on a self-hosted install, where no hosted
          // credentials exist to bind it) would be recorded as a choice that
          // createTTSProvider can never construct — voice silently dead with
          // an ok:true toast.
          if (body.provider !== undefined) {
            const VALID_TTS_PROVIDERS = ['edge', 'elevenlabs', 'sarvam', 'usejarvis'];
            if (typeof body.provider !== 'string' || !VALID_TTS_PROVIDERS.includes(body.provider)) {
              return json({ ok: false, error: `Unknown TTS provider: ${String(body.provider)}` }, 400);
            }
            if (body.provider === 'usejarvis' && !hasUsejarvisAi(ctx.config)) {
              return json({ ok: false, error: 'The Usejarvis AI voice is only available on hosted installs; pick edge, elevenlabs or sarvam.' }, 400);
            }
          }
          const { mergeTTSConfig } = await import('./config-merge.ts');

          // Same discipline as /api/config/stt POST above: single merge,
          // persist the request patch over the STORED row, publish only after
          // the persist succeeded. Without patch-over-row persistence, the
          // "Enable TTS" toggle (whose body carries no explicit choice) would
          // stamp the DEFAULT provider 'edge' into the row as user intent.
          const merged = mergeTTSConfig(ctx.config.tts, body);
          persistUserPatch('tts', body);
          ctx.config.tts = merged;

          // Hot-reload TTS provider if wsService available
          if (ctx.wsService && merged) {
            const { createTTSProvider } = await import('../comms/voice.ts');
            // Bind through the routing view: a hosted user who never chose a
            // provider must get the included voice, not the DEFAULT_CONFIG
            // 'edge' fill that `merged` carries. ctx.config.tts is already
            // the post-save value (assigned above).
            const ttsBinding = effectiveTtsForBinding(ctx.config) ?? merged;
            const provider = createTTSProvider(ttsBinding, usejarvisVoiceCredentials(ctx.config));
            // Always publish the result — including null. Leaving the previous
            // provider live after a save that yields none (disabled, or a
            // provider missing its key) keeps a stale voice speaking while the
            // response claims the new config applied.
            ctx.wsService.setTTSProvider(provider);
            if (!provider) {
              const reason = merged.enabled === false
                ? 'TTS config saved; speech is off.'
                : 'TTS config saved, but no voice is active yet (the selected provider has no usable credentials).';
              return json({ ok: true, message: reason });
            }
          }

          return json({ ok: true, message: 'TTS config saved.' });
        } catch (err) {
          return configSaveError('Error saving TTS config', err);
        }
      },
    },

    // --- Voice (wake engine + premium realtime gpt-realtime-2) ---
    '/api/config/voice': {
      GET: () => {
        const voice = ctx.config.voice;
        const rt = voice?.realtime;
        // The BINDING view, not the raw field: on a hosted install a tenant who
        // never chose gets realtime on, and reporting the stored false here
        // would show an off toggle for a feature that is actually running.
        const enablement = realtimeEnablement(ctx.config);
        const enabledNow = enablement !== 'off';
        // Whether realtime would actually resolve, so the UI can show its state
        // without exposing secrets. The plan gate is part of "available": this
        // flag is what puts the browser into raw-PCM capture mode, so reporting
        // true for a plan that excludes uj-realtime makes client and server
        // disagree about the wire format for a whole utterance.
        //
        // Read through the CACHE-ONLY gate, which never stalls this poll. It
        // does now start a background fetch on a miss or a stale entry — that
        // changed when the boot warm turned out not to cover a cache cleared by
        // SIGHUP — but the entry it writes ends the misses, so the ceiling is
        // one request per cache-empty poll rather than one per poll. An unknown
        // verdict still reads as available, matching the gate's advisory stance.
        let available = false;
        try {
          const res = resolveRealtimeVoice(ctx.config, enablement);
          available = res.ok && cachedRealtimeVerdict(res.resolved) !== false;
        } catch { available = false; }
        // NOT derived from the resolution above: that is computed under the
        // CURRENT enablement, so a tenant with realtime off resolves ok:false
        // and would be told they are billed by OpenAI — next to the toggle
        // they are deciding whether to flip. Who would serve a session is a
        // property of the install, not of whether one is switched on.
        const hostedRealtime = realtimeServedByPlan(ctx.config);
        return json({
          wake_engine: voice?.wake_engine ?? 'openwakeword',
          realtime: {
            enabled: enabledNow,
            model: rt?.model ?? 'gpt-realtime-2',
            voice: rt?.voice ?? null,
            reasoning_effort: rt?.reasoning_effort ?? 'low',
            max_session_minutes: rt?.max_session_minutes ?? 10,
            monthly_budget_usd: rt?.monthly_budget_usd ?? null,
            // Report the EFFECTIVE backstop, not the raw field. When unset the
            // resolver applies DEFAULT_BLOCKED_CATEGORIES, so returning `[]`
            // here would both misreport ("nothing blocked" while payments/etc.
            // are blocked) and let a read-modify-write round-trip persist `[]`,
            // silently disabling the safe default. `default` flags which case
            // it is so a client can tell "using the default" from an explicit set.
            blocked_categories: rt?.blocked_categories ?? DEFAULT_BLOCKED_CATEGORIES,
            blocked_categories_default: rt?.blocked_categories === undefined,
            // WHY it is on, so the tab can stop telling a hosted tenant they
            // are billed by OpenAI at $0.30/min for something their plan
            // includes, and can name the real reason it is unavailable ("not
            // in your plan") instead of "no OpenAI provider is configured".
            // Same shape as blocked_categories_default above: the effective
            // value plus a flag saying whose answer it is.
            enabled_default: enablement === 'hosted-default',
            // Who would actually SERVE a session, not merely whether this
            // install is hosted. The tab's billing copy keys off this: saying
            // "included in your plan" while a BYO key was about to be charged
            // is the assurance that made the billing bug worse than silent.
            served_by_plan: hostedRealtime,
            hosted: hasUsejarvisAi(ctx.config),
            // true when enabled AND an OpenAI provider key resolves (via
            // llm.providers or env) - reflects whether realtime would actually
            // start if voice_start arrived right now.
            available,
          },
        });
      },
      POST: async (req: Request) => {
        try {
          const body = await req.json() as Record<string, unknown>;
          const { persistUserPatch } = await import('./user-settings.ts');
          const { mergeVoiceConfig, validateVoicePatch } = await import('./config-merge.ts');

          const validation = validateVoicePatch(body);
          if (!validation.ok) return error(validation.error, 400);

          // Persist the PATCH over the stored row, never the merged in-memory
          // section: the latter always carries DEFAULT_CONFIG's
          // `realtime.enabled: false`, and writing that back reads as the user
          // explicitly declining realtime. The in-memory config is still
          // updated below for the next voice_start — the two differ on purpose.
          persistUserPatch('voice', validation.patch as Record<string, unknown>);
          const freshConfig = ctx.config;
          freshConfig.voice = mergeVoiceConfig(freshConfig.voice, validation.patch);
          // Update in-memory config so the next voice_start resolves with the
          // new settings — resolveRealtimeVoice reads ctx.config live, so no
          // provider hot-reload is needed (unlike TTS/LLM).
          ctx.config.voice = freshConfig.voice;
          return json({ ok: true, message: 'Voice config saved.' });
        } catch (err) {
          console.error('[API] Error saving voice config:', err);
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

    /**
     * Synthesize a short sample with the given voice params and return the
     * raw MP3 bytes, so the UI (onboarding + settings) can PLAY a preview
     * directly instead of relying on the WS/Pebble broadcast path. The config
     * passed here is EPHEMERAL — nothing is saved, so it never disturbs the
     * live TTS. For ElevenLabs this doubles as a real key test: a synthesis
     * call exercises the same TTS path (and scope) the app actually uses, so
     * a key that lacks `voices_read` but can synthesize still passes.
     */
    '/api/tts/preview': {
      POST: async (req: Request) => {
        try {
          const body = (await req.json().catch(() => ({}))) as {
            provider?: string; voice?: string; api_key?: string; voice_id?: string; model?: string; text?: string;
          };
          const text = (typeof body.text === 'string' && body.text.trim() ? body.text.trim() : "Hi, I'm Jarvis. This is how I'll sound.").slice(0, 280);
          const cfg: Record<string, unknown> = {
            enabled: true,
            provider: body.provider === 'elevenlabs' || body.provider === 'usejarvis' ? body.provider : 'edge',
          };
          if (body.provider === 'elevenlabs') {
            if (!body.api_key) return error('ElevenLabs API key required.', 400);
            cfg.elevenlabs = {
              api_key: body.api_key,
              voice_id: typeof body.voice_id === 'string' ? body.voice_id : undefined,
              model: typeof body.model === 'string' ? body.model : undefined,
            };
          } else if (body.provider === 'usejarvis') {
            // Hosted preview: no key in the body — the factory gets the
            // system-owned proxy credentials as its separate argument below.
            if (!hasUsejarvisAi(ctx.config)) return error('Usejarvis AI is not available on this install.', 400);
            if (typeof body.voice === 'string' && body.voice) {
              // Reject Edge neural names outright instead of letting the
              // factory silently preview 'alloy' — the sample the user hears
              // must be the voice they asked for.
              if (/Neural$/i.test(body.voice)) {
                return error(`"${body.voice}" is an Edge TTS voice — Usejarvis AI uses OpenAI-style voices (e.g. alloy).`, 400);
              }
              cfg.voice = body.voice;
            }
          } else {
            cfg.voice = body.voice || 'en-US-AriaNeural';
          }
          const { createTTSProvider } = await import('../comms/voice.ts');
          const provider = createTTSProvider(cfg as never, usejarvisVoiceCredentials(ctx.config));
          if (!provider) return error('Could not build a TTS provider from those settings.', 400);
          const audio = await provider.synthesize(text);
          return new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(msg, 502);
        }
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
        const outcome = await applyApprovalDecision('approve', req.params.id, 'dashboard', {
          approvalManager: ctx.approvalManager,
          deferredExecutor: ctx.deferredExecutor,
          wsService: ctx.wsService,
        });
        if (outcome.status === 'already_decided') return error('Request not found or already decided', 404);
        if (outcome.status !== 'approved') return error('Unexpected decision outcome', 500);
        return json({ ok: true, result: outcome.result.slice(0, 500) });
      },
    },

    '/api/authority/approvals/:id/deny': {
      POST: async (req: Request & { params: { id: string } }) => {
        if (!ctx.approvalManager || !ctx.deferredExecutor) {
          return error('Authority system not configured', 500);
        }
        const outcome = await applyApprovalDecision('deny', req.params.id, 'dashboard', {
          approvalManager: ctx.approvalManager,
          deferredExecutor: ctx.deferredExecutor,
          wsService: ctx.wsService,
        });
        if (outcome.status === 'already_decided') return error('Request not found or already decided', 404);
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
     * W4 — palette panel picks. The dashboard's `_palette` panel-mode
     * page POSTs here when the user picks a Room or hits Esc; the daemon
     * forwards the call through the registered palette handler so the
     * room-spawn / panel-close logic stays in `index.ts` where the panel
     * tracking lives. 204 on success, 503 if no handler registered.
     */
    '/api/palette/pick': {
      POST: async (req: Request) => {
        const { getPaletteHandler } = await import('./palette-controller.ts');
        const h = getPaletteHandler();
        if (!h) return error('Palette handler not registered', 503);
        const body = (await req.json().catch(() => null)) as
          | { kind?: string; key?: string; openInRoom?: boolean }
          | null;
        if (!body || (body.kind !== 'room' && body.kind !== 'object') || !body.key) {
          return error('kind ("room"|"object") and key are required', 400);
        }
        try {
          await h.pick({ kind: body.kind, key: body.key, openInRoom: !!body.openInRoom });
        } catch (err) {
          return error(`pick failed: ${(err as Error).message}`, 500);
        }
        return new Response(null, { status: 204 });
      },
    },

    '/api/palette/close': {
      POST: async () => {
        const { getPaletteHandler } = await import('./palette-controller.ts');
        const h = getPaletteHandler();
        if (!h) return error('Palette handler not registered', 503);
        try {
          await h.close();
        } catch (err) {
          return error(`close failed: ${(err as Error).message}`, 500);
        }
        return new Response(null, { status: 204 });
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

        // 1. Workflows. Pulls from the new engine-backed flow tables. The
        // display name lives on the latest version row (published, or draft
        // if there is no published yet), so we resolve per-flow.
        try {
          const flows = listFlows(undefined, { limit: 100 });
          let added = 0;
          for (const f of flows) {
            if (added >= perType) break;
            const version = f.published_version_id
              ? getFlowVersion(f.published_version_id)
              : getLatestDraft(f.id);
            const title = version?.displayName ?? f.external_id;
            if (!matches(title)) continue;
            const metaParts: string[] = [];
            if (version?.schemaVersion) metaParts.push(`v${version.schemaVersion}`);
            results.push({
              type: 'workflow',
              id: f.id,
              ref: f.id,
              title,
              meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
              status: f.status === 'ENABLED'
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
          const { saveUserSection } = await import('./user-settings.ts');
          const freshConfig = ctx.config;
          freshConfig.authority = {
            ...freshConfig.authority,
            default_level: currentConfig.default_level,
            governed_categories: currentConfig.governed_categories,
            overrides: currentConfig.overrides,
            context_rules: currentConfig.context_rules,
            learning: currentConfig.learning,
          };
          saveUserSection('authority', freshConfig.authority);

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
          const { saveUserSection } = await import('./user-settings.ts');
          const freshConfig = ctx.config;
          freshConfig.authority = {
            ...freshConfig.authority,
            overrides: currentConfig.overrides,
          };
          saveUserSection('authority', freshConfig.authority);

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
          const { saveUserSection } = await import('./user-settings.ts');
          const freshConfig = ctx.config;
          freshConfig.authority = {
            ...freshConfig.authority,
            ...ctx.authorityEngine.getConfig(),
          };
          saveUserSection('authority', freshConfig.authority);

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
