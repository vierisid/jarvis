/**
 * J.A.R.V.I.S. Daemon
 *
 * Main entry point for the JARVIS daemon process.
 * Initializes database, registers real services (Agent, Observer, WebSocket),
 * starts health monitoring, and handles graceful shutdown.
 */

import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDatabase, closeDb } from "../vault/schema.ts";
import { flushWindowState } from "./window-state.ts";
import { ServiceRegistry } from "./services.ts";
import { HealthMonitor } from "./health.ts";
import { loadConfig } from "../config/loader.ts";
import { resolveEngineIdleTtlMs } from "./config-merge.ts";
import { activeTurns } from "./active-turns.ts";
import { writeLockedPort } from "./pid.ts";
import { AgentService } from "./agent-service.ts";
import { createObservation } from "../vault/observations.ts";
import { ObserverService, mapEventType } from "./observer-service.ts";
import { WebSocketService } from "./ws-service.ts";
import { PebbleRealtimeManager } from "./pebble-realtime.ts";
import { hostedRealtimeIncluded, warmRealtimeGateFor } from './realtime-gate.ts';
import { resolveRealtimeVoice } from "../config/realtime.ts";
import { realtimeEnablement } from "./usejarvis-ai.ts";
import { REALTIME_NAV_TOOLS, REALTIME_NAV_TOOL_NAMES } from "./realtime-nav-tools.ts";
import { EventReactor } from "./event-reactor.ts";
import { EventCoalescer } from "./event-coalescer.ts";
import { CommitmentExecutor } from "./commitment-executor.ts";
import { classifyEvent } from "./event-classifier.ts";
import { createApiRoutes, setCorsOrigin } from "./api-routes.ts";
import { GoogleAuth } from "../integrations/google-auth.ts";
import { classifyGoogle, googleIdentity, makeGoogleAuth } from "../integrations/google-managed-refresh.ts";
import { ResearchQueue } from "./research-queue.ts";
import { researchQueueTool, setResearchQueueRef } from "../actions/tools/research.ts";
import { spawnPersistentAgent, assignPersistentAgentTask } from "../actions/tools/agents.ts";
import { ChannelService } from "./channel-service.ts";
import { BackgroundAgentService } from "./background-agent-service.ts";
import { AuthorityEngine } from "../authority/engine.ts";
import { ApprovalManager } from "../authority/approval.ts";
import { AuditTrail } from "../authority/audit.ts";
import { impactFromCategory } from "../roles/authority.ts";
import { SIDECAR_RECOMMENDED_VERSION } from "../sidecar/compat.ts";
import { AuthorityLearner } from "../authority/learning.ts";
import { EmergencyController } from "../authority/emergency.ts";
import { ApprovalDelivery } from "../authority/approval-delivery.ts";
import { DeferredExecutor } from "../authority/deferred-executor.ts";
import { applyApprovalDecision } from "./approval-decision.ts";
import { sendDesktopNotification } from "../comms/desktop-notify.ts";
import { SidecarManager, buildEnrollmentUrls } from "../sidecar/manager.ts";
import { claimDashboardIntro } from "../sidecar/first-run.ts";
import type { ConnectedSidecar } from "../sidecar/types.ts";
import { resolveExternalOrigin } from "../util/external-origin.ts";
import { ensureWorkflowSchema } from "../workflows/db/index.ts";
import { Worker as WorkflowWorker } from "../workflows/queue/worker.ts";
import { recoverOrphanedJobs } from "../workflows/db/repos/job-queue.ts";
import { TimerWaitpointScheduler } from "../workflows/timer-scheduler.ts";
import { createRunFlowHandler, RUN_FLOW } from "../workflows/runner/handler.ts";
import { createWorkflowRoutes } from "../workflows/api/routes.ts";
import { TriggerManager } from "../workflows/runner/triggers/manager.ts";
import { AWARENESS_EVENT_TYPE_MAP, OBSERVER_EVENT_TYPE_MAP } from "../workflows/runtime/event-types.ts";
import { WorkflowEventBus } from "../workflows/runtime/event-bus.ts";
import { WorkflowEventBuffer } from "../workflows/runtime/event-buffer.ts";
import type {
  ComposerChatMessage,
  ComposerChatReply,
  ComposerToolDef,
} from "../actions/tools/workflow-composer.ts";
import {
  bootstrapWorkflowEngine,
  type BootstrapWorkflowEngineResult,
} from "../workflows/runtime/engine-bootstrap.ts";
import { CredentialResolver } from "../workflows/credentials/adapter.ts";
import { metadataToCatalogEntry } from "../workflows/runtime/piece-catalog.ts";
import { resolveSharedRuntimePaths } from "../workflows/runtime/shared-runtime-paths.ts";
import { DEFAULT_IDS } from "../workflows/db/schema.ts";
import { apId } from "../workflows/db/ids.ts";
import { buildSandboxServiceBackends } from "../workflows/runtime/service-backends.ts";
import { EngineFlowExecutor } from "../workflows/runner/engine-runtime/engine-flow-executor.ts";

// Constants
const DEFAULT_PORT = 3142;  // JARVIS port
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.jarvis');

export interface DaemonConfig {
  port: number;
  dbPath: string;
  dataDir: string;
  healthCheckInterval?: number;  // ms
  noLocalTools?: boolean;        // disable local tool execution
}

let shutdownInProgress = false;
let registry: ServiceRegistry | null = null;
let healthMonitor: HealthMonitor | null = null;
let commitmentExecutor: CommitmentExecutor | null = null;
let bgAgent: BackgroundAgentService | null = null;
let awarenessService: import('../awareness/service.ts').AwarenessService | null = null;
let goalService: import('../goals/service.ts').GoalService | null = null;
let workflowWorker: WorkflowWorker | null = null;
let triggerManager: TriggerManager | null = null;
let workflowEngineShutdown: (() => Promise<void>) | null = null;
let systemCron: import('./system-cron.ts').SystemCronService | null = null;
let usageAlerts: import('./usage-alerts-service.ts').UsageAlertsService | null = null;
let timerScheduler: TimerWaitpointScheduler | null = null;
let settingsReload: import('./settings-reload.ts').SettingsReloadCoordinator | null = null;
/** Set once the sidecar manager is up; re-pushes the pebble realtime
 * capability after a settings reload (a plan change arrives that way, and the
 * advertisement is otherwise computed only at connect). */
let readvertiseRealtime: (() => Promise<void>) | null = null;
/** Graceful-drain deadline (ms), set from config at boot. Default 75s. */
let drainDeadlineMs = 75_000;

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<DaemonConfig> {
  const args = process.argv.slice(2);
  const config: Partial<DaemonConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--port':
        config.port = parseInt(args[++i]!, 10);
        break;
      case '--db-path':
        config.dbPath = args[++i]!;
        break;
      case '--data-dir':
        config.dataDir = args[++i]!;
        break;
      case '--health-interval':
        config.healthCheckInterval = parseInt(args[++i]!, 10);
        break;
      case '--no-local-tools':
        config.noLocalTools = true;
        break;
      case '--help':
      case '-h':
        console.log(`
J.A.R.V.I.S. Daemon

Usage:
  bun run src/daemon/index.ts [options]

Options:
  --port <number>          WebSocket server port (default: ${DEFAULT_PORT})
  --db-path <path>         Database file path (default: ~/.jarvis/jarvis.db)
  --data-dir <path>        Data directory (default: ~/.jarvis)
  --health-interval <ms>   Health check interval in ms (default: 30000)
  --no-local-tools         Disable local tool execution (run_command, read_file, etc).
                           Tools will only work when routed to a sidecar via target param.
  --help, -h               Show this help message

Example:
  bun run src/daemon/index.ts --port 3142 --data-dir ~/.jarvis
        `);
        process.exit(0);
    }
  }

  return config;
}

/**
 * Ensure data directory exists
 */
function ensureDataDir(dataDir: string): void {
  if (!existsSync(dataDir)) {
    console.log(`[Daemon] Creating data directory: ${dataDir}`);
    mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Log timestamp helper
 */
function logWithTimestamp(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Handle graceful shutdown
 */
async function handleShutdown(signal: string): Promise<void> {
  if (shutdownInProgress) {
    // A repeated SIGNAL means the operator/user wants to force-quit now.
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      console.log('\n[Daemon] Second signal — forcing immediate exit');
      process.exit(1);
    }
    // But an internal error (uncaughtException/unhandledRejection) while we're
    // already draining -- e.g. a stray rejection from a still-streaming turn --
    // must NOT abort the drain (that would skip teardown + lose window state).
    console.warn(`[Daemon] ${signal} during drain (ignored; drain continues)`);
    return;
  }

  shutdownInProgress = true;
  console.log(`\n[Daemon] Received ${signal}, draining gracefully (deadline ${drainDeadlineMs}ms)...`);

  try {
    // One wall-clock budget for the whole drain (turns + workflow), kept under
    // the supervisor's SIGKILL grace.
    const drainUntil = Date.now() + drainDeadlineMs;

    // ---- Phase 1: QUIESCE -- stop accepting NEW work; keep in-flight alive ----
    // New agent turns are refused (agent-service throws DrainingError); stop the
    // timer/event SOURCES that would spawn turns or workflow jobs. The agent, WS,
    // sidecar, and workflow worker stay UP so in-flight work can finish + stream.
    activeTurns.quiesce();

    // Stop the TIMER scheduler so it doesn't enqueue new resume jobs mid-drain.
    if (timerScheduler) {
      timerScheduler.stop();
      timerScheduler = null;
    }

    // Stop system cron (publishes cron.* events on the shared bus)
    if (systemCron) {
      systemCron.stop();
      systemCron = null;
    }

    // Stop the hosted usage threshold check
    if (usageAlerts) {
      usageAlerts.stop();
      usageAlerts = null;
    }

    // Stop commitment executor
    if (commitmentExecutor) {
      commitmentExecutor.stop();
      commitmentExecutor = null;
    }

    // Stop goal service
    if (goalService) {
      await goalService.stop();
      goalService = null;
    }

    // Stop awareness service
    if (awarenessService) {
      await awarenessService.stop();
      awarenessService = null;
    }

    // Stop background agent (separate browser)
    if (bgAgent) {
      await bgAgent.stop();
      bgAgent = null;
    }

    // Stop the trigger manager so no NEW RUN_FLOW jobs get enqueued while we
    // drain (in-flight runs already claimed keep going).
    if (triggerManager) {
      await triggerManager.stop();
      triggerManager = null;
    }

    // Begin stopping the workflow worker NOW, unawaited: stop() flips
    // `running=false` synchronously so it won't claim a FRESH job during the
    // drain window (which would then get only a sliver of budget and orphan),
    // while its already-in-flight run keeps going. Awaited, bounded, in phase 3.
    const workerStopping = workflowWorker ? workflowWorker.stop() : null;

    // ---- Phase 2: DRAIN -- await in-flight agent turns up to the deadline ----
    // Per UPDATES.md a turn is NOT checkpointed mid-flight: if it overruns we
    // abandon it (the process exits, the user re-asks). Workflow runs ARE
    // durable (per-step checkpoint + resume), so they're handled in teardown.
    const active = activeTurns.active;
    if (active > 0) console.log(`[Drain] waiting for ${active} in-flight turn(s)...`);
    const { drained, remaining } = await activeTurns.drain(Math.max(0, drainUntil - Date.now()));
    if (drained) {
      console.log('[Drain] all in-flight turns completed');
    } else {
      console.log(`[Drain] deadline reached; abandoning ${remaining} in-flight turn(s) (user re-asks)`);
    }

    // ---- Phase 3: TEARDOWN ----
    // Stop health monitor
    if (healthMonitor) {
      healthMonitor.stop();
    }

    // Stop all services (reverse order: websocket -> observers -> agent). Safe
    // now: turns are drained, so tearing down the agent/WS drops nothing live.
    if (registry) {
      await registry.stopAll();
    }

    // Stop the workflow worker (drains its in-flight run, then exits the poll
    // loop) -- but bounded by the remaining budget. If a long run overruns, we
    // leave it RUNNING; the next boot's recoverOrphanedJobs re-queues it to
    // resume promptly (workflow state is durable, unlike agent turns).
    if (workflowWorker) {
      const wfBudget = Math.max(2000, drainUntil - Date.now());
      const stopped = await Promise.race([
        (workerStopping ?? Promise.resolve()).then(() => true),
        new Promise<boolean>((r) => {
          const t = setTimeout(() => r(false), wfBudget);
          t.unref?.();
        }),
      ]);
      if (!stopped) {
        console.log('[Drain] workflow worker over deadline; in-flight run left RUNNING for boot-recovery');
      }
      workflowWorker = null;
    }

    // Stop the engine SandboxApi server (after the worker has drained, since
    // an in-flight engine subprocess may still be calling back to it).
    if (workflowEngineShutdown) {
      try { await workflowEngineShutdown(); } catch (e) {
        console.warn(`[Daemon] Workflow engine shutdown failed: ${(e as Error).message}`);
      }
      workflowEngineShutdown = null;
    }

    // Flush any debounced per-room window bounds before we exit, otherwise a
    // panel moved within the last 400 ms (the write debounce) is lost on quit.
    // Safe no-op if window-state was never touched this session.
    flushWindowState();

    // Close the shared DB. `closeWorkflowDb` aliases `closeDb` since the
    // workflow tables live in the same file -- one call is enough.
    closeDb();
    console.log('[Daemon] Database closed');

    console.log('[Daemon] Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Daemon] Error during shutdown:', error);
    process.exit(1);
  }
}

/**
 * Print startup banner
 */
function printBanner(config: DaemonConfig): void {
  console.log(`
     ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
     ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
     ██║███████║██████╔╝██║   ██║██║███████╗
██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
 ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝

Just A Rather Very Intelligent System
  `);
  console.log('[Daemon] Configuration:');
  console.log(`  Port:      ${config.port}`);
  console.log(`  Data Dir:  ${config.dataDir}`);
  console.log(`  DB Path:   ${config.dbPath}`);
  console.log('');
}

/**
 * Start the JARVIS daemon
 */
export async function startDaemon(userConfig?: Partial<DaemonConfig>): Promise<void> {
  // Load config from YAML (with defaults)
  let jarvisConfig;
  try {
    jarvisConfig = await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[Daemon] Failed to parse config file: ${message}`);
    console.error('[Daemon] Fix the YAML syntax in ~/.jarvis/config.yaml or delete it to use defaults.\n');
    process.exit(1);
  }

  // Drain budget: default 75s; a non-positive value falls back; cap at 85s so a
  // misconfig can't push the drain past the supervisor's kill grace (systemd
  // TimeoutStopSec=90) and get SIGKILLed mid-drain.
  const configuredDrain = jarvisConfig.daemon.drain_deadline_ms;
  drainDeadlineMs = configuredDrain && configuredDrain > 0 ? configuredDrain : 75_000;
  if (drainDeadlineMs > 85_000) {
    console.warn(`[Daemon] drain_deadline_ms=${drainDeadlineMs} exceeds the safe ceiling; capping at 85000`);
    drainDeadlineMs = 85_000;
  }

  // Determine data directory: CLI args > config file > default
  const dataDir = userConfig?.dataDir ?? jarvisConfig.daemon.data_dir ?? DEFAULT_DATA_DIR;

  // If user specified a custom data dir but no db path, use jarvis.db in that dir
  const dbPath = userConfig?.dbPath ?? jarvisConfig.daemon.db_path ?? path.join(dataDir, 'jarvis.db');

  // Merge configuration
  const port = userConfig?.port ?? jarvisConfig.daemon.port ?? DEFAULT_PORT;
  const config: DaemonConfig = {
    port,
    dataDir,
    dbPath,
    healthCheckInterval: userConfig?.healthCheckInterval ?? 30000,
    noLocalTools: userConfig?.noLocalTools ?? false,
  };

  // Resolve the listen spec ONCE, before anything is persisted: a malformed
  // `daemon.listen` must fail fast here, not after the lockfile write (a
  // stale TCP lockfile from a mid-boot crash would mislead `jarvis stop`).
  const { resolveListen } = await import('../config/loader.ts');
  let listen: import('../config/loader.ts').ListenSpec;
  try {
    listen = resolveListen({ port, listen: jarvisConfig.daemon.listen });
  } catch (err) {
    console.error(`\n[Daemon] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Record the actual bound port in the lockfile so `jarvis stop` knows which
  // port to verify even when the daemon was started with --port, JARVIS_PORT,
  // or a mid-run config change. No-op if we don't hold the lock (e.g. tests).
  // In unix-socket mode no TCP port exists to verify, so nothing is recorded
  // and `jarvis stop` is pid-only (resolveStopPort returns port null).
  if (listen.kind === 'tcp') {
    writeLockedPort(port);
  }

  // If dbPath is relative, make it absolute within dataDir
  if (!path.isAbsolute(config.dbPath)) {
    config.dbPath = path.join(config.dataDir, config.dbPath);
  }

  printBanner(config);

  try {
    // 1. Ensure data directory exists
    ensureDataDir(config.dataDir);

    // 2. Initialize database
    logWithTimestamp(`Initializing database at ${config.dbPath}`);
    initDatabase(config.dbPath);
    logWithTimestamp('Database initialized successfully');

    // 2.0. Wire LLM usage tracking to the vault DB so every chatTier/streamTier
    // call appends an llm_usage row. Best-effort: tracking failures never break
    // the LLM call itself. Pass a resolver so DB reopens are picked up.
    const { setUsageDatabase } = await import('../llm/usage.ts');
    const { getDb } = await import('../vault/schema.ts');
    setUsageDatabase(() => {
      try { return getDb(); } catch { return null; }
    });

    // 2.1. Add workflow tables (flow / flow_run / flow_version /
    // app_connection / waitpoint / store_entry / workflow_file /
    // workflow_job / trigger_event) to the shared Jarvis DB. Idempotent.
    // Single file => single backup unit.
    ensureWorkflowSchema();
    logWithTimestamp('Workflow schema ready');

    // 2a. Seed webapp templates (upserts, safe to run every startup)
    const { seedWebappTemplates } = await import('../vault/webapp-template-seeds.ts');
    seedWebappTemplates();

    // 2a-bis. Relocate a pre-JARVIS_HOME keychain into the data dir before
    // anything reads a credential, so hydration below sees the moved store and
    // a data-dir backup finally includes it. No-op on a normal ~/.jarvis
    // install, and it never removes the legacy pair unless the copy verified.
    const { migrateKeychainToDataDir } = await import('../vault/keychain.ts');
    try {
      migrateKeychainToDataDir();
    } catch (err) {
      console.error('[Daemon] Keychain relocation failed; continuing with the existing store:', err);
    }

    // 2b. Load all LLM settings (providers, credentials, single-LLM default,
    // tiers) from the DB + encrypted keychain. This is the sole source of LLM
    // config - config.yaml and env vars contribute nothing.
    const { mergeLLMSettingsIntoConfig } = await import('./llm-settings.ts');
    mergeLLMSettingsIntoConfig(jarvisConfig);
    logWithTimestamp('LLM settings loaded from database');

    // 2c. User-owned settings (personality, voice, authority, channels,
    // onboarding, ...) follow the same rule: the DB is the sole authority,
    // config.yaml is read-only system config the brain never writes. A
    // legacy file that still carries user sections seeds the DB exactly
    // once, then env overrides are re-applied so JARVIS_* still wins.
    const { importLegacyUserSettings, mergeUserSettingsIntoConfig } = await import('./user-settings.ts');
    const { readRawConfigFile, applyEnvOverrides } = await import('../config/loader.ts');
    const rawConfigFile = await readRawConfigFile().catch(() => null);
    const importedSections = importLegacyUserSettings(rawConfigFile);
    if (importedSections.length > 0) {
      logWithTimestamp(`Imported legacy config.yaml sections into the DB: ${importedSections.join(', ')}`);
    }
    mergeUserSettingsIntoConfig(jarvisConfig);
    applyEnvOverrides(jarvisConfig);
    logWithTimestamp('User settings loaded from database');

    // 2d. Cron timezone: hosted brains run on UTC VPSs, so every cron in the
    // process evaluates in the user's IANA timezone from the system config.
    if (jarvisConfig.timezone) {
      try {
        const { setCronTimezone } = await import('../lib/cron-scheduler.ts');
        setCronTimezone(jarvisConfig.timezone);
        logWithTimestamp(`Cron timezone: ${jarvisConfig.timezone}`);
      } catch {
        console.warn(`[Daemon] Invalid timezone "${jarvisConfig.timezone}" in config - using machine local time`);
      }
    }

    // 3. Create service registry
    registry = new ServiceRegistry();

    // 3a. Settings hot reload: constructed right after DB hydration so every
    // later block can register per-section appliers as its targets come into
    // scope (pebble providers, channels, observers, ...). The choke-point
    // listener makes EVERY saveUserSection/saveGoogleSettings — HTTP route,
    // voice intent, pebble toggle — schedule the section's appliers.
    const { SettingsReloadCoordinator } = await import('./settings-reload.ts');
    const { setSectionSavedListener } = await import('./user-settings.ts');
    const { reloadUsejarvisAiBlock } = await import('../config/loader.ts');
    settingsReload = new SettingsReloadCoordinator(jarvisConfig, {
      // File-authoritative SYSTEM sections are re-read on every reloadAll so
      // a provisioner rotation of the usejarvis_ai key (or un-hosting) takes
      // effect on SIGHUP / POST /api/config/reload without a restart.
      reloadSystemSections: (cfg) => reloadUsejarvisAiBlock(cfg),
    });
    setSectionSavedListener((section) => settingsReload?.sectionChanged(section));

    // 3b. Anonymous usage telemetry (opt-out). Constructed here so it can be
    //     registered before the LLM-dependent services and counts installs
    //     even while the daemon is still in onboarding/setup mode.
    const { TelemetryService } = await import('../telemetry/index.ts');
    const telemetryService = new TelemetryService({
      config: jarvisConfig,
      packageRoot: path.join(import.meta.dir, '..', '..'),
    });

    // 4. Create proactive modules
    const heartbeatConfig = jarvisConfig.heartbeat;
    const reactor = new EventReactor();
    const coalescer = new EventCoalescer();

    // 4b. Create GoogleAuth if configured
    let googleAuth: GoogleAuth | null = null;
    // Managed instances have NO client credentials — the control plane holds
    // them — so this cannot key on their presence or hosted Google would never
    // start.
    googleAuth = makeGoogleAuth(jarvisConfig);
    // A config we REFUSED (a mis-rendered managed block) is logged HERE, once,
    // rather than by the classifier: that runs on every status poll too, and
    // logging inside it printed the same line twice per poll forever.
    const googleShape = classifyGoogle(jarvisConfig);
    if (googleShape.mode === 'none' && googleShape.reason) {
      console.error(`[Daemon] Google is disabled: ${googleShape.reason}`);
    }
    if (googleAuth) {
      if (googleAuth.isAuthenticated()) {
        console.log('[Daemon] Google OAuth: authenticated (Gmail + Calendar observers enabled)');
      } else {
        console.log('[Daemon] Google OAuth: credentials found but not authenticated');
        console.log('[Daemon] Run: bun run src/scripts/google-setup.ts to authorize');
      }
    }

    // 4c. Create research queue
    const researchQueue = new ResearchQueue();
    setResearchQueueRef(researchQueue);

    // 5. Create real services
    const agentService = new AgentService(jarvisConfig);
    agentService.setResearchQueue(researchQueue);
    const observerService = config.noLocalTools
      ? null
      : new ObserverService(reactor, coalescer, googleAuth ?? undefined, config.dataDir);
    // Hosted push bridge targets (GOOGLE.md). All absent on self-hosted, where
    // the observers' own poll timers are the whole story.
    observerService?.setPushTargets({
      pubsubTopic: jarvisConfig.google?.pubsub_topic,
      pushCallback: jarvisConfig.google?.push_callback,
      channelToken: jarvisConfig.google?.channel_token,
    });
    // Hosted mode: daemon.listen = unix:/run/jarvis/u_<id>.sock binds a unix
    // socket and no TCP port at all (Caddy is the only way in). `listen` was
    // resolved (and validated) once, before the lockfile write above.
    const wsService = new WebSocketService(
      config.port,
      agentService,
      listen.kind === 'unix' ? listen.path : undefined,
    );

    // 5b. Create channel service for external comms (Telegram, Discord)
    const channelService = new ChannelService(jarvisConfig, agentService);

    // 5c. Create commitment executor (notify-then-execute)
    const aggressiveness = heartbeatConfig?.aggressiveness ?? 'moderate';
    const executor = new CommitmentExecutor(aggressiveness as any);

    // 6. Wire reactor callback for WebSocket notifications
    reactor.setReactionCallback((text, priority) => {
      wsService.broadcastNotification(text, priority);
    });
    // Note: reactor.setAgentService + executor.setAgentService wired to bgAgent after startAll (step 10c)

    // 6b. Wire delegation progress to WebSocket for sub-agent visibility
    agentService.setDelegationProgressCallback((event) => {
      wsService.broadcastSubAgentProgress(event);
    });

    // 6b'. Phase 4: surface conv-tier task lifecycle events to the UI so it can
    // render status pills while a delegated task is in flight. No-op when the
    // user has not configured llm.tiers.conversation (classic orchestrator mode).
    agentService.setConvTaskEventListener((event) => {
      // Derive a stable `status` from the event TYPE so it matches what the
      // event actually represents (the record's mutable `status` field may
      // have advanced by the time this fires - e.g., a snapshotted
      // task_started event shouldn't claim status='completed').
      const statusForEvent =
        event.type === 'task_started' ? 'running' :
        event.type === 'task_completed' ? 'completed' :
        event.type === 'task_failed' ? 'failed' :
        'cancelled';
      wsService.broadcastTaskEvent({
        type: event.type,
        task_id: event.record.id,
        template: event.record.request.template,
        intent: event.record.request.intent,
        status: statusForEvent,
        elapsedMs: Date.now() - event.record.startedAt,
        summary: 'envelope' in event ? event.envelope.summary : undefined,
      });
    });

    // 6c. Create sidecar manager
    const sidecarManager = new SidecarManager(jarvisConfig.daemon.data_dir.replace('~', os.homedir()));
    // Public-origin precedence: env > public_url > legacy brain_domain >
    // local fallback. Re-check env only to attribute the startup log source.
    const externalOrigin = resolveExternalOrigin(jarvisConfig);
    for (const warning of externalOrigin.warnings) {
      console.warn(`[ExternalOrigin] ${warning}`);
    }
    const brainSource: 'env' | 'config' | 'public_url' | 'default' = externalOrigin.source === 'public_url'
      ? (process.env.JARVIS_PUBLIC_URL ? 'env' : 'public_url')
      : externalOrigin.source === 'brain_domain'
        ? (process.env.JARVIS_BRAIN_DOMAIN ? 'env' : 'config')
        : 'default';
    const brainDomain = externalOrigin.httpOrigin;
    sidecarManager.setBrainUrl(brainDomain, brainSource);

    // Panel webviews must render the same brain origin the JWT pins: the sidecar
    // rejects any panel URL whose host differs from its brain claim, and serves
    // its token only to that origin. Derive the panel origin from the same
    // brain claim the manager signs so localhost / 127.0.0.1 / remote all agree.
    const pebbleBrainWs = buildEnrollmentUrls(brainDomain).brainWs;
    const pebblePanelOrigin = `${pebbleBrainWs.startsWith('wss') ? 'https' : 'http'}://${new URL(pebbleBrainWs).host}`;

    // 6d. Wire sidecar manager to WebSocket server for WS routing
    wsService.getServer().setSidecarManager(sidecarManager);

    // 6e. Ambient UX (Phase 2): native pebble overlay (GDI+/Cocoa/Cairo,
    // per-platform). On sidecar connect, if the sidecar advertises the
    // `pebble` capability, dispatch `pebble.spawn`. On disconnect or daemon
    // shutdown, the sidecar's own Stop() closes the overlay cleanly.
    //
    // The daemon (brain) is the source of truth for pebble state. The
    // sidecar emits a `pebble.summon` event when the user presses the
    // summon hotkey (Ctrl+Space); the daemon receives it and drives the
    // state machine via `pebble.set_state` RPC. For now this runs a fixed
    // demo cycle (listening → thinking → speaking → idle) so we can
    // verify all the state renderers end-to-end. Real voice/LLM
    // integration replaces the timer logic in a follow-up ticket.
    // Ambient UI (pebble + sub-pebbles + voice-driven panels) is the
    // default daily-driver experience as of Phase 2. Set
    // `JARVIS_AMBIENT_UI=0` to fall back to dashboard-only mode (useful
    // for headless servers, CI, or users who only want the web UI).
    if (process.env.JARVIS_AMBIENT_UI !== '0') {
      const spawnedOn = new Set<string>();

      // Per-sidecar in-flight summon control. Tracks whether a summon is
      // active and lets us cancel mid-flight when the user dismisses with
      // a second hotkey press.
      // `sessionId` is set only for hotkey summons (the sidecar mints it and
      // stamps it on both `pebble.summon` and any later `pebble.mic_blocked`),
      // so a mic refusal can unwind exactly the slot it belongs to and never a
      // turn that happens to be in flight.
      const pendingSummons = new Map<string, { cancelled: boolean; sessionId?: string }>();

      // Fallback timers for the bare-"Jarvis" listening state. If the sidecar's
      // session capture never produces an `audio.session_end` (dropped event,
      // VAD wedged, user walked away), the pebble would stay `listening` forever
      // with wake-word suppressed. These recover it. Cleared the moment a session
      // IS consumed in onComplete, so they never interrupt a real response cycle.
      // Generous: longer than any normal VAD capture (pre-speech + hard-cap), so
      // it only fires when session_end genuinely never came, not on a slow start.
      const WAKE_LISTEN_FALLBACK_MS = 30_000;
      const pendingListenTimers = new Map<string, ReturnType<typeof setTimeout>>();
      const clearListenTimer = (sidecarId: string) => {
        const t = pendingListenTimers.get(sidecarId);
        if (t) {
          clearTimeout(t);
          pendingListenTimers.delete(sidecarId);
        }
      };

      // Per-sidecar guard so the wake-word handler can't race itself: a second
      // wake segment may arrive while the first is still transcribing, before
      // pendingSummons is claimed. Set synchronously on entry, cleared in finally.
      const wakeInFlight = new Set<string>();

      // setState pairs the visual state with optional bubble body text. The
      // text wins over the per-state placeholder ("speaking…", "listening —
      // go ahead.") so we can surface the live LLM response instead of the
      // generic copy. Empty/undefined text falls back to the placeholder.
      // Last state mirrored to each sidecar's tray menu, so we only push
      // `tray.status` when the state actually changes (state churns fast during
      // a turn; the tray only reads it on menu-open, so a per-change push would
      // be pure waste otherwise).
      const lastTrayState = new Map<string, string>();
      const setState = async (sidecarId: string, state: string, text?: string) => {
        try {
          const params: { state: string; text?: string } = { state };
          if (text !== undefined) params.text = text;
          await sidecarManager.dispatchRPC(sidecarId, 'pebble.set_state', params);
          // Mirror the state to the tray menu header (best-effort, deduped).
          if (lastTrayState.get(sidecarId) !== state) {
            lastTrayState.set(sidecarId, state);
            void sidecarManager.dispatchRPC(sidecarId, 'tray.status', { state }).catch(() => {});
          }
        } catch (err) {
          console.warn(`[ambient-ui] pebble.set_state(${state}) on ${sidecarId} failed:`, err);
        }
      };

      // Realtime nav-tool execution for the pebble: open a native room panel (or
      // window-manage it) on the pebble's machine, mirroring the one-shot intent
      // path. (ROOMS/dashboardURL/boundsForRoom/trackPanel/findPanel are defined
      // further down in this same scope; this closure runs at tool-call time, by
      // when they're initialised.) Returns a confirmation, or null if `name`
      // isn't a nav tool so the caller falls through to the agent tool bridge.
      const executePebbleNavTool = async (
        sidecarId: string,
        name: string,
        args: Record<string, unknown>,
      ): Promise<string | null> => {
        if (!REALTIME_NAV_TOOL_NAMES.has(name)) return null;
        const openRoom = async (key: string): Promise<string> => {
          const meta = ROOMS[key];
          if (!meta) return `I don't have a "${key}" screen.`;
          try {
            const result = await sidecarManager.dispatchRPC(sidecarId, 'panel.spawn', {
              url: dashboardURL(key),
              title: meta.title,
              bounds: boundsForRoom(key, meta.w, meta.h),
              resizable: true,
              always_on_top: meta.alwaysOnTop ?? false,
              multi_instance: false,
            });
            const id = (result && typeof result === 'object' && 'id' in (result as object))
              ? String((result as { id?: unknown }).id ?? '') : '';
            if (id) trackPanel(sidecarId, { id, key, title: meta.title });
            return `Opened ${meta.title}.`;
          } catch (err) {
            console.warn(`[pebble-realtime] open room "${key}" failed:`, err);
            return `I couldn't open ${meta.title}.`;
          }
        };
        switch (name) {
          case 'open_dashboard_room':
            return openRoom(String(args.room ?? ''));
          case 'dashboard_room_action':
            // In-room actions target the dashboard SPA, which a native panel
            // doesn't receive — opening the room is the useful part here.
            return openRoom(String(args.room ?? ''));
          case 'control_dashboard_window': {
            const action = String(args.action ?? '');
            const target = findPanel(sidecarId, args.target ? String(args.target) : undefined);
            if (!target) return "There's no window open to do that with.";
            const stateMap: Record<string, string> = {
              maximize: 'maximized', maximized: 'maximized',
              minimize: 'minimized', minimized: 'minimized',
              restore: 'normal', normal: 'normal',
            };
            try {
              if (action === 'close') {
                await sidecarManager.dispatchRPC(sidecarId, 'panel.close', { id: target.id });
                untrackPanel(sidecarId, target.id);
                return `Closed ${target.title}.`;
              }
              if (action === 'focus') {
                await sidecarManager.dispatchRPC(sidecarId, 'panel.focus', { id: target.id });
                return 'Here it is.';
              }
              if (stateMap[action]) {
                await sidecarManager.dispatchRPC(sidecarId, 'panel.set_window_state', { id: target.id, state: stateMap[action] });
                return `Done.`;
              }
              return "I'm not sure how to do that with the window.";
            } catch {
              return "I couldn't do that with the window.";
            }
          }
          case 'go_back_to_thread':
            return 'Okay.'; // the pebble has no dashboard thread to return to
          default:
            return null;
        }
      };

      // ─────────────────── Native pebble realtime voice ───────────────────
      // The summon hotkey toggles a perpetual realtime (gpt-realtime) session
      // when realtime is enabled. The sidecar is the audio device: it streams
      // mic PCM up (`pebble.audio_frame`) and plays streamed PCM down
      // (`pebble.play_pcm`); the daemon runs the realtime session itself. See
      // PebbleRealtimeManager + PebbleAudioTransport — all the OpenAI protocol
      // logic is reused from the dashboard realtime path.
      const pebbleRealtime = new PebbleRealtimeManager({
        dispatchRPC: (sidecarId, method, params) => sidecarManager.dispatchRPC(sidecarId, method, params ?? {}),
        dispatchNotify: (sidecarId, method, params) => sidecarManager.dispatchNotify(sidecarId, method, params ?? {}),
        getAudioChannel: (sidecarId) => sidecarManager.getAudioChannel(sidecarId),
        resolve: () => {
          const cfg = agentService.getConfig();
          return resolveRealtimeVoice(cfg, realtimeEnablement(cfg));
        },
        // Agent tools + the nav tools (open_dashboard_room, …) so realtime voice
        // can drive the desktop UI just like the one-shot path ("open settings").
        tools: () => [...agentService.getOrchestrator().getRealtimeTools(), ...REALTIME_NAV_TOOLS],
        instructions: () => agentService.buildRealtimeVoiceInstructions(),
        executeToolCall: async (sidecarId, name, args, blockedCategories) => {
          // Nav tools open a native panel on the pebble's machine (the realtime
          // model otherwise had no way to honor "open workflows / settings").
          const nav = await executePebbleNavTool(sidecarId, name, args);
          if (nav !== null) return nav;
          return agentService.getOrchestrator().executeRealtimeToolCall(name, args, { blockedCategories });
        },
        onState: (sidecarId, state, text) => { void setState(sidecarId, state, text); },
        onStatus: (sidecarId, status, detail) => {
          console.log(`[pebble-realtime] ${sidecarId} ${status}${detail ? `: ${detail}` : ''}`);
          // Echo lifecycle to the sidecar so it can stop capture / show the
          // reason when the daemon closes or errors the session.
          void sidecarManager.dispatchRPC(sidecarId, 'pebble.realtime_status', { state: status, detail: detail ?? '' })
            .catch(() => {/* sidecar may lack the handler / be gone */});
        },
        // Plan-gate refusal → re-push configure_realtime with the now-cached
        // definitive verdict so the summon key downgrades to one-shot capture.
        // (advertiseRealtime is defined just below; only ever called at runtime.)
        readvertise: (sidecarId) => {
          void advertiseRealtime(sidecarId).catch((err) =>
            console.warn('[pebble-realtime] post-refusal re-advertisement failed:', err),
          );
        },
      });

      // Tell each pebble-capable sidecar whether realtime is available so its
      // summon hotkey knows to toggle a live session vs. the one-shot capture.
      const advertiseRealtime = async (sidecarId: string) => {
        const cfg = agentService.getConfig();
        const res = resolveRealtimeVoice(cfg, realtimeEnablement(cfg));
        // The advertisement must agree with the starters' plan gate, or the
        // summon hotkey opens sessions the plan refuses at dial.
        const enabled = res.ok && (await hostedRealtimeIncluded(res.resolved));
        console.log(`[pebble-realtime] configure_realtime → ${sidecarId} enabled=${enabled}${res.ok ? '' : ` (${res.reason})`}`);
        await sidecarManager.dispatchRPC(sidecarId, 'pebble.configure_realtime', { enabled })
          .catch((err) => console.warn(`[pebble-realtime] configure_realtime dispatch failed (older sidecar?):`, err));
      };
      // Re-advertise after a settings reload: the advertisement is otherwise
      // computed once at CONNECT, so a sidecar that attached while the plan
      // excluded realtime keeps its summon hotkey in one-shot mode until it
      // reconnects — even after an upgrade. reloadAll clears the gate cache,
      // so this re-asks the catalog rather than repeating a stale verdict.
      readvertiseRealtime = async () => {
        for (const s of sidecarManager.listConnected()) {
          if (s.capabilities.includes('pebble')) await advertiseRealtime(s.id);
        }
      };
      // Registered on the coordinator (not just the SIGHUP handler) so BOTH
      // reload entry points — SIGHUP and POST /api/config/reload — re-push
      // the advertisement; the route previously cleared the gate cache but
      // left every connected pebble on its stale configure_realtime verdict.
      settingsReload?.setPostReloadAll(async () => {
        await readvertiseRealtime?.();
      });
      sidecarManager.onSidecarConnected((sidecar) => {
        if (!sidecar.capabilities.includes('pebble')) return;
        // The listener is typed `=> void` and the dispatch loop only catches
        // SYNCHRONOUS throws, so an async body would surface a rejection as
        // an unhandled one. Keep the contract: fire and swallow here.
        void advertiseRealtime(sidecar.id).catch((err) =>
          console.warn('[pebble-realtime] advertisement failed:', err),
        );
      });

      // Sidecar → daemon realtime control + mic stream.
      const pebbleMicFrames = new Map<string, number>(); // sidecarId -> frame count (diagnostic)
      sidecarManager.onEvent((sidecarId, event) => {
        if (event.event_type === 'pebble.realtime_start') {
          console.log(`[pebble-realtime] realtime_start from ${sidecarId} — opening session`);
          pebbleMicFrames.set(sidecarId, 0);
          void pebbleRealtime.start(sidecarId);
        } else if (event.event_type === 'pebble.realtime_stop') {
          console.log(`[pebble-realtime] realtime_stop from ${sidecarId}`);
          pebbleRealtime.stop(sidecarId);
        } else if (event.event_type === 'pebble.audio_frame') {
          const data = (event.payload as { data?: unknown })?.data;
          if (typeof data === 'string') {
            const n = (pebbleMicFrames.get(sidecarId) ?? 0) + 1;
            pebbleMicFrames.set(sidecarId, n);
            // Confirm the mic stream is flowing without spamming: first frame, then every ~5s.
            if (n === 1 || n % 125 === 0) console.log(`[pebble-realtime] mic frames from ${sidecarId}: ${n}`);
            pebbleRealtime.pushMicChunk(sidecarId, Buffer.from(data, 'base64'));
          }
        }
      });
      // Mic PCM arriving on the dedicated audio channel (binary, isolated from
      // the bulk control connection) — the preferred path; the pebble.audio_frame
      // event above is the fallback when no audio channel is connected.
      sidecarManager.onAudioFrame((sidecarId, frame) => {
        const n = (pebbleMicFrames.get(sidecarId) ?? 0) + 1;
        pebbleMicFrames.set(sidecarId, n);
        if (n === 1 || n % 125 === 0) console.log(`[pebble-realtime] mic frames (audio channel) from ${sidecarId}: ${n}`);
        pebbleRealtime.pushMicChunk(sidecarId, frame);
      });
      sidecarManager.onSidecarDisconnected((sidecarId) => {
        pebbleRealtime.stop(sidecarId);
        // Per-sidecar transient state — drop with the connection so the maps
        // stay bounded by connected sidecars, not lifetime-distinct ones.
        clearListenTimer(sidecarId);
        lastTrayState.delete(sidecarId);
        pebbleMicFrames.delete(sidecarId);
      });

      // STT + TTS providers for the pebble's voice loop. Both built from
      // the same jarvisConfig.* the dashboard uses so API keys / provider
      // choice (OpenAI Whisper / Groq / Local / Sarvam for STT;
      // edge-tts / ElevenLabs / Sarvam for TTS) carry over.
      let pebbleSTT: import('../comms/voice.ts').STTProvider | null = null;
      let pebbleTTS: import('../comms/voice.ts').TTSProvider | null = null;
      // Guard on the BINDING result, not on config.stt existing (like
      // channel-service): the hosted default applies even when the section
      // is absent, and an outer config.stt check would leave pebble STT
      // dead on a surface where Telegram/Discord transcribe fine.
      try {
        const { createSTTProvider } = await import('../comms/voice.ts');
        const { effectiveSttForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
        const sttBinding = effectiveSttForBinding(jarvisConfig);
        pebbleSTT = sttBinding
          ? createSTTProvider(sttBinding, usejarvisVoiceCredentials(jarvisConfig))
          : null;
        if (pebbleSTT) {
          console.log(`[ambient-ui] STT provider for pebble: ${sttBinding!.provider}`);
        }
      } catch (err) {
        console.warn('[ambient-ui] failed to init STT provider:', err);
      }
      if (jarvisConfig.tts?.enabled) {
        try {
          const { createTTSProvider } = await import('../comms/voice.ts');
          const { effectiveTtsForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
          const ttsBinding = effectiveTtsForBinding(jarvisConfig);
          pebbleTTS = ttsBinding
            ? createTTSProvider(ttsBinding, usejarvisVoiceCredentials(jarvisConfig))
            : null;
          if (pebbleTTS) {
            console.log(`[ambient-ui] TTS provider for pebble: ${ttsBinding?.provider ?? 'edge-tts'}`);
          }
        } catch (err) {
          console.warn('[ambient-ui] failed to init TTS provider:', err);
        }
      }

      // Settings hot reload: rebuild the pebble's providers whenever the
      // stt/tts sections change (dashboard save, voice command, reloadAll).
      // The dashboard-side wsService providers have their own appliers in
      // the main registration block.
      settingsReload?.registerApplier('stt', async (cfg) => {
        const { createSTTProvider } = await import('../comms/voice.ts');
        const { effectiveSttForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
        const sttBinding = effectiveSttForBinding(cfg);
        pebbleSTT = sttBinding ? createSTTProvider(sttBinding, usejarvisVoiceCredentials(cfg)) : null;
        console.log(`[ambient-ui] STT provider ${pebbleSTT ? `set to ${sttBinding?.provider}` : 'cleared'} (settings reload)`);
      });
      settingsReload?.registerApplier('tts', async (cfg) => {
        pebbleTTS = null;
        if (cfg.tts?.enabled) {
          const { createTTSProvider } = await import('../comms/voice.ts');
          const { effectiveTtsForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
          const ttsBinding = effectiveTtsForBinding(cfg);
          pebbleTTS = ttsBinding ? createTTSProvider(ttsBinding, usejarvisVoiceCredentials(cfg)) : null;
        }
        console.log(`[ambient-ui] TTS provider ${pebbleTTS ? 'rebuilt' : 'cleared'} (settings reload)`);
      });

      // ttsMimeType maps the configured TTS provider to a MIME hint the
      // sidecar uses when sniffing audio bytes. (The sidecar primarily
      // uses magic-byte detection; this is just the fallback hint.)
      const ttsMimeType = (cfg: typeof jarvisConfig.tts): string => {
        if (!cfg) return 'audio/mp3';
        switch (cfg.provider) {
          case 'sarvam':
            return 'audio/wav';
          case 'elevenlabs':
          case 'edge':
          case 'usejarvis': // proxy /audio/speech is asked for response_format: 'mp3'
          default:
            return 'audio/mp3';
        }
      };

      // (T17e replaced the artificial typewriter pacing with the LLM's
      // own token cadence — see runResponseCycle below.)

      // estimateAudioDurationMs returns the playback duration of the
      // synthesized clip in milliseconds. WAV: parse `data` chunk against
      // sample rate/channels/bits. MP3: skip any ID3v2 tag, find the first
      // MPEG sync frame, read its bitrate from the header, and compute
      // `bytes * 8 / bitrate`. Reading the actual bitrate is necessary
      // because providers vary widely (edge-tts ≈ 48 kbps, ElevenLabs
      // ≈ 128 kbps) and an assumed bitrate produces wildly wrong durations.
      // Returns null when the format isn't recognized so the caller can
      // fall back to a chars-based heuristic.
      const estimateAudioDurationMs = (audio: Buffer): number | null => {
        if (audio.length < 4) return null;
        // WAV
        if (audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46 && audio[3] === 0x46) {
          let pos = 12;
          let sampleRate = 0, channels = 0, bitsPerSample = 0, dataLen = 0;
          while (pos + 8 <= audio.length) {
            const id = audio.subarray(pos, pos + 4).toString('ascii');
            const size = audio.readUInt32LE(pos + 4);
            pos += 8;
            if (pos + size > audio.length) break;
            if (id === 'fmt ' && size >= 16) {
              channels = audio.readUInt16LE(pos + 2);
              sampleRate = audio.readUInt32LE(pos + 4);
              bitsPerSample = audio.readUInt16LE(pos + 14);
            } else if (id === 'data') {
              dataLen = size;
            }
            pos += size;
          }
          if (sampleRate && channels && bitsPerSample && dataLen) {
            const samples = dataLen / (channels * bitsPerSample / 8);
            return Math.round((samples / sampleRate) * 1000);
          }
          return null;
        }
        // MP3 — parse the first frame header for an accurate bitrate.
        // Use readUInt8 throughout to keep TS happy under
        // noUncheckedIndexedAccess; bounds are already validated.
        let pos = 0;
        if (audio.length >= 10 && audio.readUInt8(0) === 0x49 && audio.readUInt8(1) === 0x44 && audio.readUInt8(2) === 0x33) {
          // ID3v2 header: 10 bytes + synchsafe size in bytes 6..9.
          const tagSize =
            ((audio.readUInt8(6) & 0x7f) << 21) |
            ((audio.readUInt8(7) & 0x7f) << 14) |
            ((audio.readUInt8(8) & 0x7f) << 7) |
            (audio.readUInt8(9) & 0x7f);
          pos = 10 + tagSize;
        }
        // MPEG-1 / MPEG-2 Layer 3 bitrate tables (kbps; index 0 = free, 15 = bad).
        const v1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
        const v2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
        while (pos + 4 <= audio.length) {
          const b0 = audio.readUInt8(pos);
          const b1 = audio.readUInt8(pos + 1);
          if (b0 === 0xff && (b1 & 0xe0) === 0xe0) {
            const b2 = audio.readUInt8(pos + 2);
            const versionBits = (b1 >> 3) & 0x03; // 11=v1, 10=v2, 00=v2.5
            const layerBits = (b1 >> 1) & 0x03;   // 01=Layer 3
            const bitrateIdx = (b2 >> 4) & 0x0f;
            const sampleRateIdx = (b2 >> 2) & 0x03;
            if (layerBits !== 0 && bitrateIdx !== 0 && bitrateIdx !== 0x0f && sampleRateIdx !== 0x03) {
              const kbps = versionBits === 0x03 ? v1L3[bitrateIdx] : v2L3[bitrateIdx];
              if (kbps) {
                return Math.round((audio.length * 8) / kbps);
              }
            }
          }
          pos++;
        }
        return null;
      };

      // Wrap raw PCM s16 mono in a minimal RIFF/WAVE header so the
      // STT provider (which uploads via multipart and labels as audio.webm
      // by default) sees a recognizable audio container. Whisper sniffs
      // file content, not just the filename hint.
      const pcmToWav = (pcm: Buffer, sampleRate: number, channels: number): Buffer => {
        const bitsPerSample = 16;
        const byteRate = (sampleRate * channels * bitsPerSample) / 8;
        const blockAlign = (channels * bitsPerSample) / 8;
        const dataLen = pcm.length;
        const chunkSize = 36 + dataLen;
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(chunkSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataLen, 40);
        return Buffer.concat([header, pcm]);
      };

      // The very first sidecar ever to connect to THIS brain gets the dashboard
      // opened alongside the pebble: a lone pebble on a fresh install reads as
      // "nothing happened", and on Linux there is no tray to find the dashboard
      // from. Scoped to the brain (claimDashboardIntro persists the flag in the
      // vault), so a re-issued enrollment token or a second machine is NOT a
      // first run. Distinct from the sidecar-local "Open dashboard at startup"
      // preference, which the sidecar honours itself on every launch.
      //
      // Never throws: this is a nicety, and the caller's catch block owns the
      // pebble's spawn bookkeeping — a failure here must not un-guard that.
      const openFirstRunDashboard = async (sidecar: ConnectedSidecar): Promise<void> => {
        // Everything lives inside the try — claimDashboardIntro() does
        // synchronous SQLite I/O and can throw on a sick vault, and the caller's
        // catch owns the pebble's spawn bookkeeping.
        try {
          // Without the 'windows' capability the sidecar has no panel service at
          // all, so the spawn could only fail — leave the intro unclaimed for a
          // capable sidecar instead of burning it here.
          if (!sidecar.capabilities.includes('windows')) return;
          if (!claimDashboardIntro()) return;
          // The full dashboard SPA at '#/' — the same window (and the same
          // panel id) the tray's "Open dashboard" opens, so this can never
          // produce a duplicate. NOT dashboardURL(), which renders a single
          // chrome-less room body.
          await sidecarManager.dispatchRPC(sidecar.id, 'panel.spawn', {
            id: 'tray:chat',
            url: `${pebblePanelOrigin}/#/`,
            title: 'JARVIS',
            bounds: { x: -1, y: -1, w: 1100, h: 760 },
            resizable: true,
            multi_instance: false,
          });
          console.log(`[ambient-ui] first-run dashboard opened on ${sidecar.id}`);
        } catch (err) {
          // Losing the race for the 'tray:chat' id (the user clicked the tray, or
          // the sidecar's own open-at-startup preference got there first) means
          // the dashboard IS up — the intro's whole purpose is served. Not a
          // failure; say so rather than crying wolf in the log.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('panel already exists')) {
            console.log(`[ambient-ui] first-run dashboard already open on ${sidecar.id}`);
            return;
          }
          console.warn(`[ambient-ui] first-run dashboard open failed on ${sidecar.id}:`, err);
        }
      };

      sidecarManager.onSidecarConnected(async (sidecar) => {
        if (!sidecar.capabilities.includes('pebble')) {
          console.log(`[ambient-ui] Sidecar ${sidecar.id} lacks 'pebble' capability — skipping native pebble spawn`);
          return;
        }
        if (spawnedOn.has(sidecar.id)) return;
        spawnedOn.add(sidecar.id);
        try {
          const result = await sidecarManager.dispatchRPC(sidecar.id, 'pebble.spawn', {
            cursor_offset_x: 34,
            cursor_offset_y: 40,
            summon_hotkey: 'ctrl+space',
            palette_hotkey: 'ctrl+k',
          });
          console.log(`[ambient-ui] Native pebble spawned on ${sidecar.id}:`, result);
          // W6 — push initial blinded state so the eye-strike glyph
          // matches awareness.enabled across daemon restarts.
          const awarenessEnabled = (jarvisConfig.awareness as { enabled?: boolean })?.enabled ?? true;
          sidecarManager.dispatchRPC(sidecar.id, 'pebble.set_blinded', { blinded: !awarenessEnabled })
            .catch(() => { /* sidecar might not have the cap yet */ });
          // Deliberately last: the pebble comes up first, then the dashboard
          // lands behind it. Note this ties the intro to the 'pebble'
          // capability — unreachable today (both 'pebble' and 'windows' are
          // defaults, and LoadConfig re-adds any default a config file drops),
          // but if pebble ever becomes disableable, hoist this call out of the
          // pebble gate or a windows-only sidecar will see nothing at all.
          await openFirstRunDashboard(sidecar);
        } catch (err) {
          spawnedOn.delete(sidecar.id);
          console.warn(`[ambient-ui] Failed to spawn native pebble on ${sidecar.id}:`, err);
        }
      });

      sidecarManager.onSidecarDisconnected((sidecarId) => {
        spawnedOn.delete(sidecarId);
        const ctrl = pendingSummons.get(sidecarId);
        if (ctrl) ctrl.cancelled = true;
        pendingSummons.delete(sidecarId);
        clearListenTimer(sidecarId);
      });

      // ─────────────────────────── Sub-pebble rail ───────────────────────────
      // Phase A — when a sub-agent task launches via taskManager, dispatch a
      // sub_pebble.spawn to every connected sidecar that advertises the
      // sub_pebble capability. On completion / failure, flip its state. Task
      // ids are the sub-pebble ids so updates address the right overlay.
      //
      // Slot allocation: per-sidecar map of taskId -> slot. On launch we pick
      // the lowest unused slot (so closing a middle one doesn't leave a gap
      // on the next spawn). Color picks round-robin from a 6-element palette
      // keyed off the task id hash so the same task always wears the same
      // color across paint cycles.
      const subPebbleSlots = new Map<string, Map<string, number>>(); // sidecarId -> (taskId -> slot)
      const SUB_PEBBLE_PALETTE: string[] = ['amber', 'sage', 'violet', 'mustard', 'teal', 'vermilion'];
      const colorForTask = (taskId: string): string => {
        let hash = 0;
        for (let i = 0; i < taskId.length; i++) hash = ((hash << 5) - hash + taskId.charCodeAt(i)) | 0;
        return SUB_PEBBLE_PALETTE[Math.abs(hash) % SUB_PEBBLE_PALETTE.length] ?? 'amber';
      };
      const nextSlot = (sidecarId: string): number => {
        const used = subPebbleSlots.get(sidecarId);
        if (!used) return 0;
        const taken = new Set(used.values());
        for (let i = 0; i < 32; i++) if (!taken.has(i)) return i;
        return used.size; // fallback past 32 simultaneous, unlikely
      };
      const subPebbleCapableSidecars = (): string[] => {
        const ids: string[] = [];
        for (const sc of sidecarManager.listSidecars()) {
          if (sc.connected && (sc.capabilities ?? []).includes('sub_pebble')) ids.push(sc.id);
        }
        return ids;
      };
      // The machine currently in use — set at the start of each pebble response
      // cycle. The same JARVIS brain is shared across a user's machines, but
      // each machine has its own pebble showing what JARVIS does there, so a
      // background task's sub-pebble belongs to ONE machine (the one it was
      // launched from) rather than being mirrored onto every connected sidecar.
      let activePebbleSidecar: string | null = null;
      const pickSubPebbleSidecar = (): string | null => {
        const capable = subPebbleCapableSidecars();
        if (capable.length === 0) return null;
        if (activePebbleSidecar && capable.includes(activePebbleSidecar)) return activePebbleSidecar;
        // No recent pebble interaction (e.g. a task spawned outside any pebble
        // turn): use the sole capable machine if there's exactly one, else give
        // up rather than guess which machine the user is at.
        return capable.length === 1 ? capable[0]! : null;
      };

      // Phase B — per-sub-pebble expansion state. Daemon owns this so a
      // click flip can fetch fresh task data before dispatching.
      const subPebbleExpanded = new Map<string, boolean>(); // taskId -> expanded
      // taskId -> the machine that owns this task's sub-pebble (recorded at
      // launch). Lifecycle updates (state/summary) route back to this machine
      // only; each task lives on exactly one machine.
      const subPebbleSidecar = new Map<string, string>(); // taskId -> sidecarId

      // Phase B+ — summarize a completed task's response into ~3 short
      // sentences so the sub-pebble bubble can show something digestible
      // even when the agent's raw response is many paragraphs. Stores on
      // the task via taskManager.setSummary so the dashboard panel route
      // can read it too. Re-dispatches set_expanded if the bubble is
      // still open by the time the summary lands.
      const summarizeTaskAsync = async (taskId: string, sidecarId: string): Promise<void> => {
        try {
          const tm = agentService.getTaskManager();
          const llm = agentService.getLLMManager();
          if (!tm || !llm) return;
          const task = tm.getTask(taskId);
          if (!task || !task.result || !task.result.response) return;
          const raw = task.result.response.trim();
          // Skip if response is already short — the bubble can show it directly.
          if (raw.length < 240) {
            tm.setSummary(taskId, raw);
          } else {
            const t0 = Date.now();
            const messages = [
              {
                role: 'system' as const,
                content: `You are a summarizer for a small ambient floating display. Compress the agent's response into 2 or 3 short sentences a user can read at a glance. Be specific — keep names, numbers, and key recommendations. No markdown, no bullet points, no preamble like "The agent says". Just the summary itself.`,
              },
              {
                role: 'user' as const,
                content: `Task: ${task.task}\n\nAgent response:\n${raw.slice(0, 4000)}\n\nSummary:`,
              },
            ];
            // Route through Groq (or whatever cheap provider is configured)
            // when available — summaries don't need top-tier reasoning and
            // sub-cent-per-task makes the always-on summary affordable.
            // chatWithOverride silently falls back to the default provider
            // if the requested one isn't registered.
            const resp = await llm.chatWithOverride(messages, 'groq', { max_tokens: 180, temperature: 0.3 });
            const summary = (resp.content || '').trim();
            if (summary) {
              tm.setSummary(taskId, summary);
              console.log(`[sub-pebble] summary for ${taskId} in ${Date.now() - t0}ms (${summary.length} chars)`);
            }
          }
          // Re-dispatch set_expanded if the bubble is still open so the
          // user sees the summary land in place.
          if (subPebbleExpanded.get(taskId)) {
            const fresh = tm.getTask(taskId);
            if (!fresh) return;
            const elapsedS = Math.round(((fresh.completedAt ?? Date.now()) - fresh.startedAt) / 1000);
            const display = fresh.summary ?? (fresh.result?.response ?? '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
            await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.set_expanded', {
              id: taskId, expanded: true,
              agent: fresh.agentName,
              task: fresh.task.slice(0, 200),
              result: display,
              elapsed_s: elapsedS,
            });
          }
        } catch (err) {
          console.warn(`[sub-pebble] summarize ${taskId} failed:`, err);
        }
      };

      // Phase B — sub_pebble.clicked event from sidecar. Toggle the
      // expanded state and dispatch set_expanded with fresh task data
      // (label/task/result/elapsed) so the bubble reads what's current,
      // not what was true at spawn time.
      // pebble.open_answer — user clicked the "open full ↗" button on the
      // speaking bubble. Spawn a panel pointing at `#/_answer_<id>` which
      // renders the full LLM response as markdown.
      sidecarManager.onEvent(async (sidecarId, event) => {
        if (event.event_type !== 'pebble.open_answer') return;
        const payload = (event.payload ?? {}) as { answer_id?: unknown };
        const answerID = String(payload.answer_id ?? '');
        if (!answerID) return;
        const url = `${pebblePanelOrigin}/#/_answer_${answerID}`;
        try {
          const result = await sidecarManager.dispatchRPC(sidecarId, 'panel.spawn', {
            url,
            title: 'JARVIS answer',
            bounds: { x: -1, y: -1, w: 540, h: 640 },
            resizable: true,
            always_on_top: false,
            multi_instance: true,
          });
          const id = (result && typeof result === 'object' && 'id' in (result as object))
            ? String((result as { id?: unknown }).id ?? '')
            : '';
          if (id) trackPanel(sidecarId, { id, key: 'answer_full', title: 'JARVIS answer' });
          console.log(`[pebble] open_answer panel spawned for answer=${answerID}`);
        } catch (err) {
          console.warn(`[pebble] open_answer panel.spawn failed for ${answerID}:`, err);
        }
      });

      // sub_pebble.open_full — user clicked the "open full" button inside
      // the bubble. Spawn a panel pointing at the dashboard's
      // `#/_task_<id>` route which renders the task's full response.
      sidecarManager.onEvent(async (sidecarId, event) => {
        if (event.event_type !== 'sub_pebble.open_full') return;
        const payload = (event.payload ?? {}) as { id?: unknown };
        const taskId = String(payload.id ?? '');
        if (!taskId) return;
        const url = `${pebblePanelOrigin}/#/_task_${taskId}`;
        try {
          const result = await sidecarManager.dispatchRPC(sidecarId, 'panel.spawn', {
            url,
            title: 'Sub-agent result',
            bounds: { x: -1, y: -1, w: 540, h: 640 },
            resizable: true,
            always_on_top: false,
            multi_instance: true, // allow multiple full-result panels open at once
          });
          const id = (result && typeof result === 'object' && 'id' in (result as object))
            ? String((result as { id?: unknown }).id ?? '')
            : '';
          if (id) {
            // Use a synthetic room key so the tracker doesn't collide with
            // the 13 real rooms; window-state persistence won't fire either
            // since 'task_full' isn't in the meta table.
            trackPanel(sidecarId, { id, key: 'task_full', title: 'Sub-agent result' });
          }
          console.log(`[sub-pebble] open_full panel spawned for task=${taskId}`);
        } catch (err) {
          console.warn(`[sub-pebble] open_full panel.spawn failed for ${taskId}:`, err);
        }
      });

      sidecarManager.onEvent(async (sidecarId, event) => {
        if (event.event_type !== 'sub_pebble.clicked') return;
        const payload = (event.payload ?? {}) as { id?: unknown };
        const id = String(payload.id ?? '');
        if (!id) return;
        const tm = agentService.getTaskManager();
        if (!tm) return;
        const task = tm.getTask(id);
        if (!task) {
          console.warn(`[sub-pebble] click for unknown task id=${id} — skipping`);
          return;
        }
        const next = !(subPebbleExpanded.get(id) ?? false);
        subPebbleExpanded.set(id, next);
        const elapsedS = Math.round(((task.completedAt ?? Date.now()) - task.startedAt) / 1000);
        // Prefer the LLM summary when available (lands a beat after
        // completion via summarizeTaskAsync). Fall back to a markdown-
        // stripped slice of the raw response.
        const rawResult = task.result?.response ?? '';
        const cleaned = rawResult.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
        const display = task.summary ?? cleaned.slice(0, 220);
        const resultPreview = task.status === 'running' ? '' : display;
        try {
          await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.set_expanded', {
            id,
            expanded: next,
            agent: task.agentName,
            task: task.task.slice(0, 200),
            result: resultPreview,
            elapsed_s: elapsedS,
          });
          console.log(`[sub-pebble] click id=${id} expanded=${next}`);
        } catch (err) {
          console.warn(`[sub-pebble] set_expanded for ${id} failed:`, err);
        }
      });

      // taskManager is initialized inside agentService.start(), which the
      // service registry runs AFTER this ambient block. Poll until it
      // appears, then attach the lifecycle listener. Bounded to ~20s so
      // we don't spin forever on a daemon that failed to start agents.
      const attachSubPebbleListener = async (): Promise<void> => {
        const deadline = Date.now() + 20_000;
        let taskManager = agentService.getTaskManager();
        while (!taskManager && Date.now() < deadline) {
          await new Promise<void>(r => setTimeout(r, 200));
          taskManager = agentService.getTaskManager();
        }
        if (!taskManager) {
          console.warn('[sub-pebble] taskManager never appeared — sub-pebble rail disabled');
          return;
        }
        taskManager.subscribeLifecycle(async (event, task) => {
          // Single active machine: a task's sub-pebble lives on ONE machine.
          // On launch, attach to the machine currently in use; for later events
          // route to the machine that owns this task (recorded at launch).
          const sidecarId = event === 'launch'
            ? pickSubPebbleSidecar()
            : (subPebbleSidecar.get(task.id) ?? null);
          if (!sidecarId) {
            if (event === 'launch') {
              console.log(`[sub-pebble] launch task=${task.id} — no machine in use, skipping`);
            }
            return;
          }
          {
            try {
              if (event === 'launch') {
                let used = subPebbleSlots.get(sidecarId);
                if (!used) { used = new Map(); subPebbleSlots.set(sidecarId, used); }
                // A6 — hard cap at 8 sub-pebbles per sidecar to keep the
                // rail from overflowing the screen. When at the cap,
                // close the oldest completed task first (status != running);
                // if nothing completed, close the literal oldest. This is
                // ambient UI, not a backlog manager — long-term inspection
                // happens in the agent strip room.
                const SUB_PEBBLE_CAP = 8;
                while (used.size >= SUB_PEBBLE_CAP) {
                  const tm = agentService.getTaskManager();
                  // Pick the oldest completed/failed first; fall back to
                  // oldest of any.
                  let evictId: string | null = null;
                  let oldestSlot = -1;
                  for (const [id, slot] of used.entries()) {
                    const t = tm?.getTask(id);
                    if (t && t.status !== 'running') {
                      if (oldestSlot < 0 || slot > oldestSlot) {
                        oldestSlot = slot;
                        evictId = id;
                      }
                    }
                  }
                  if (!evictId) {
                    // No completed tasks — evict literal oldest (lowest slot).
                    let lowestSlot = Infinity;
                    for (const [id, slot] of used.entries()) {
                      if (slot < lowestSlot) { lowestSlot = slot; evictId = id; }
                    }
                  }
                  if (!evictId) break; // shouldn't happen
                  const evictSlot = used.get(evictId);
                  try {
                    await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.close', { id: evictId });
                  } catch (err) {
                    console.warn(`[sub-pebble] cap-evict close ${evictId} failed:`, err);
                  }
                  used.delete(evictId);
                  subPebbleExpanded.delete(evictId);
                  subPebbleSidecar.delete(evictId);
                  // Reflow surviving slots (same pattern as voice close).
                  if (evictSlot !== undefined) {
                    for (const [otherId, slot] of used.entries()) {
                      if (slot > evictSlot) used.set(otherId, slot - 1);
                    }
                  }
                  console.log(`[sub-pebble] cap reached — evicted ${evictId}`);
                }
                const slot = nextSlot(sidecarId);
                used.set(task.id, slot);
                subPebbleSidecar.set(task.id, sidecarId);
                await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.spawn', {
                  id: task.id,
                  color: colorForTask(task.id),
                  slot,
                  label: task.agentName,
                  state: 'working',
                });
                console.log(`[sub-pebble] spawn task=${task.id} agent=${task.agentName} slot=${slot}`);
              } else if (event === 'complete' || event === 'fail') {
                // Success turns the drop green (the brand "done" state) so the
                // rail shows finished work at a glance; failures stop the pulse
                // (idle) and recolor to vermilion so the user sees red.
                await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.set_state', {
                  id: task.id, state: event === 'complete' ? 'done' : 'idle',
                });
                if (event === 'fail') {
                  await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.set_color', {
                    id: task.id, color: 'vermilion',
                  });
                }
                // If the bubble is currently expanded, push fresh content
                // so the user sees the result without re-clicking. For
                // successful completions, show "summarizing…" instead of
                // the raw truncated text so the user knows a better
                // summary is on the way (summarizeTaskAsync re-dispatches
                // ~1–2 s later with the real summary). For failures, show
                // the error text immediately since there's no summary
                // coming.
                if (subPebbleExpanded.get(task.id)) {
                  const elapsedS = Math.round(((task.completedAt ?? Date.now()) - task.startedAt) / 1000);
                  const rawResult = task.result?.response ?? '';
                  const cleaned = rawResult.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
                  const placeholder = event === 'complete' && cleaned.length > 240
                    ? 'summarizing…'
                    : cleaned.slice(0, 220);
                  await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.set_expanded', {
                    id: task.id, expanded: true,
                    agent: task.agentName,
                    task: task.task.slice(0, 200),
                    result: placeholder,
                    elapsed_s: elapsedS,
                  });
                }
                // Kick off the ambient summary (success only — no point
                // summarizing an error). Fire-and-forget; the summarizer
                // re-dispatches set_expanded if the bubble is still open.
                if (event === 'complete') {
                  void summarizeTaskAsync(task.id, sidecarId);
                }
                console.log(`[sub-pebble] ${event} task=${task.id}`);
                // Per the design rule: sub-pebbles stay until the user
                // explicitly closes them ("close this sub-agent" or click).
                // No auto-close here.
              }
            } catch (err) {
              console.warn(`[sub-pebble] ${event} dispatch on ${sidecarId} failed:`, err);
            }
          }
        });
        console.log('[sub-pebble] subscribed to taskManager lifecycle events');
      };
      // Fire-and-forget: the poll loop above runs in the background so
      // daemon startup isn't blocked. Errors get logged.
      void attachSubPebbleListener();

      // When a sidecar disconnects, drop its slot table so the next reconnect
      // starts fresh. Sub-pebbles on the disconnected sidecar are already
      // gone (its process exited or the connection died).
      sidecarManager.onSidecarDisconnected((sidecarId) => {
        subPebbleSlots.delete(sidecarId);
      });

      // W6-T2 — long-press on pebble disc toggles "blinded" state. Flips
      // awareness.enabled in config (persists), starts/stops the awareness
      // service in place (no daemon restart), and pushes the visual state
      // to every connected pebble. Speaks a confirmation through TTS.
      sidecarManager.onEvent(async (sidecarId, event) => {
        if (event.event_type !== 'pebble.blind_toggle') return;
        try {
          const { persistPlainUserPatch } = await import('./user-settings.ts');
          const wasEnabled = jarvisConfig.awareness?.enabled ?? true;
          const nextEnabled = !wasEnabled;
          (jarvisConfig.awareness as { enabled?: boolean }).enabled = nextEnabled;
          // Persist only the key that changed. Writing the whole in-memory
          // section would stamp every DEFAULT_CONFIG fill into the row, pinning
          // this install to today's capture interval and cooldowns forever.
          persistPlainUserPatch('awareness', { enabled: nextEnabled });
          // Toggle live awareness service if it exists.
          if (awarenessService) awarenessService.toggle(nextEnabled);
          // Push visual: blinded = !enabled.
          await sidecarManager.dispatchRPC(sidecarId, 'pebble.set_blinded', { blinded: !nextEnabled })
            .catch(() => { /* sidecar may have detached */ });
          const ack = nextEnabled
            ? "Awareness back on. I can see your screen again."
            : "Awareness off. I can't see anything until you toggle it back.";
          await speakConfirmation(sidecarId, ack, { cancelled: false });
          console.log(`[ambient-ui] blind toggle → awareness.enabled=${nextEnabled}`);
        } catch (err) {
          console.warn('[ambient-ui] blind_toggle failed:', err);
        }
      });

      // W6-T1 — pebble eye glyph fires when sidecar emits a screen_capture
      // event (awareness/OCR ticked). Debounced: each fresh capture
      // restarts the 800 ms timer so a burst of captures keeps the glyph
      // lit continuously. Failures are swallowed — the visual indicator
      // is best-effort.
      const eyeTimers = new Map<string, ReturnType<typeof setTimeout>>();
      sidecarManager.onEvent((sidecarId, event) => {
        if (event.event_type !== 'screen_capture') return;
        // Fire-and-forget; cap concurrency on the wire.
        sidecarManager.dispatchRPC(sidecarId, 'pebble.set_eye', { active: true })
          .catch(() => { /* sidecar may not have pebble cap */ });
        const existing = eyeTimers.get(sidecarId);
        if (existing) clearTimeout(existing);
        eyeTimers.set(sidecarId, setTimeout(() => {
          sidecarManager.dispatchRPC(sidecarId, 'pebble.set_eye', { active: false })
            .catch(() => { /* ignore */ });
          eyeTimers.delete(sidecarId);
        }, 800));
      });

      // pebble.summon — first press starts listening, second press dismisses.
      // The actual voice work (STT → LLM → TTS) runs once the audio session
      // completes (audioSessions.onComplete below), since that's when we
      // have the PCM to transcribe.
      sidecarManager.onEvent((sidecarId, event) => {
        if (event.event_type !== 'pebble.summon') return;
        const existing = pendingSummons.get(sidecarId);
        if (existing && !existing.cancelled) {
          existing.cancelled = true;
          pendingSummons.delete(sidecarId);
          setState(sidecarId, 'idle', '');
          // Cut off any in-flight TTS playback. Best-effort — the RPC
          // is a no-op when nothing is playing (e.g. dismissed during
          // listening/thinking). Without this, the audio keeps playing
          // through to the end even though the bubble is back to idle.
          sidecarManager.dispatchRPC(sidecarId, 'pebble.stop_audio', {}).catch(() => { /* sidecar may not have audio */ });
          console.log(`[ambient-ui] pebble.summon (dismiss) on ${sidecarId}`);
          return;
        }
        const payload = (event.payload as { session_id?: string; muted?: boolean } | undefined) ?? {};
        if (payload.muted === true) {
          // The sidecar sends the press even when the mic is muted, because
          // this hotkey doubles as the dismiss gesture (handled above). With
          // nothing to dismiss there's no cycle to open: claiming a summon slot
          // here would strand the pebble in `listening` waiting on audio the
          // sidecar has already refused to capture. No text argument — the
          // sidecar's bubble already says why.
          setState(sidecarId, 'muted');
          console.log(`[ambient-ui] pebble.summon on ${sidecarId} — ignored, microphone muted`);
          return;
        }
        pendingSummons.set(sidecarId, { cancelled: false, sessionId: payload.session_id });
        setState(sidecarId, 'listening', '');
        console.log(`[ambient-ui] pebble.summon on ${sidecarId} — listening for audio…`);
      });

      // W2-T22 + T23: audio session arrives → STT → LLM → speaking → idle.
      // The pebble's state transitions are now driven by the actual audio
      // pipeline (capture done → transcribe → think → speak), not timers.
      const audioSessions = new (await import('./audio-sessions.ts')).AudioSessionRegistry();
      audioSessions.attach((cb) => sidecarManager.onEvent(cb));
      // T20 — voice-driven settings mutation. Patches `jarvisConfig` and
      // persists via the DB settings store; the saveUserSection choke-point
      // hook then runs the stt/tts appliers (pebble + dashboard providers),
      // so the next response uses the new setting without a daemon restart.
      // Both appliers persist BEFORE mutating jarvisConfig and report failure
      // instead of throwing: persistUserPatch throws when the keychain refuses
      // a credential, and an exception here would abort the whole response
      // cycle — the user would get silence instead of an answer.
      const applyTTSEnabled = async (enabled: boolean): Promise<boolean> => {
        const { persistUserPatch } = await import('./user-settings.ts');
        // Patch-over-STORED-row (see persistUserPatch): persisting the merged
        // in-memory section here would record the DEFAULT provider 'edge' as
        // a choice the user never made, pinning hosted installs to Edge
        // instead of the included Usejarvis AI voice.
        try {
          persistUserPatch('tts', { enabled });
        } catch (err) {
          console.error('[ambient-ui] Could not save the TTS setting:', err);
          return false;
        }
        if (!jarvisConfig.tts) jarvisConfig.tts = { enabled };
        else jarvisConfig.tts.enabled = enabled;
        // Await the applier (vs the save hook's scheduled run) so pebbleTTS
        // is already rebuilt when the confirmation reply is spoken — "turn
        // on text to speech" must be audible in the SAME response cycle.
        await settingsReload?.applyNow('tts');
        console.log(`[ambient-ui] TTS ${enabled ? 'enabled' : 'disabled'} via voice command`);
        return true;
      };

      const applySTTProvider = async (provider: 'openai' | 'groq' | 'sarvam' | 'local' | 'usejarvis'): Promise<boolean> => {
        const { persistUserPatch } = await import('./user-settings.ts');
        const { hasUsejarvisAi } = await import('./usejarvis-ai.ts');
        if (!jarvisConfig.stt) jarvisConfig.stt = { provider };
        // Refuse the switch if the target provider has no credentials
        // configured — we don't want to silently break STT. The hosted
        // 'usejarvis' choice is gated on the system usejarvis_ai block
        // (its key never lives in cfg.stt).
        const hasKey = (() => {
          if (provider === 'usejarvis') return hasUsejarvisAi(jarvisConfig);
          if (provider === 'local') return !!jarvisConfig.stt!.local?.endpoint;
          const sub = (jarvisConfig.stt as unknown as Record<string, { api_key?: string } | undefined>)[provider];
          return !!sub?.api_key;
        })();
        if (!hasKey) return false;
        // Patch-over-STORED-row: the provider IS explicit intent here, but
        // the rest of the merged in-memory section must not ride along.
        try {
          persistUserPatch('stt', { provider });
        } catch (err) {
          console.error('[ambient-ui] Could not save the STT provider:', err);
          return false;
        }
        if (!jarvisConfig.stt) jarvisConfig.stt = { provider };
        else jarvisConfig.stt.provider = provider;
        // Deterministic swap: the next transcription must already use the
        // new provider when we confirm the switch to the user.
        await settingsReload?.applyNow('stt');
        console.log(`[ambient-ui] STT provider switched to ${provider} via voice command`);
        return true;
      };

      // T19 — region selection ("help with this"). Tracks the
      // original transcript while the sidecar overlay runs so the
      // LLM gets the user's question paired with the captured image.
      const pendingRegionByPebble = new Map<string, { userText: string; ctrl: { cancelled: boolean }; startedAt: number }>();
      // Sidecars whose region.captured is currently running through a response
      // cycle. onEvent listeners are NOT awaited serially, so a duplicate or
      // late `region.captured` can land while the first one's async cycle is
      // still in flight. Without this guard, the naive "no pending region →
      // reset state" recovery would tear down the live cycle's pebble state and
      // summon slot mid-answer. We instead keep the pendingRegion entry alive
      // for the whole cycle and skip re-entry while this set holds the sidecar.
      const regionCycleActive = new Set<string>();

      // Identity-guarded release of a summon slot. A voice turn can outlive the
      // controller that started it (the user dismisses and immediately re-summons,
      // or a wake segment races a manual press), so a stale cycle finishing must
      // NOT blindly `pendingSummons.delete(sidecarId)` — that would evict a newer
      // turn's slot and wedge the pebble. Only clear when (a) this exact `ctrl`
      // still owns the slot, and (b) the region overlay flow hasn't taken the turn
      // over (it re-uses the same `ctrl` and owns teardown via its own finally, so
      // clearing here would pull the slot out from under an in-flight capture).
      const clearSummon = (sidecarId: string, ctrl: { cancelled: boolean }) => {
        if (pendingSummons.get(sidecarId) !== ctrl) return;
        if (pendingRegionByPebble.get(sidecarId)?.ctrl === ctrl) return;
        pendingSummons.delete(sidecarId);
      };

      const tryHandleRegionIntent = async (
        sidecarId: string,
        userText: string,
        ctrl: { cancelled: boolean },
      ): Promise<boolean> => {
        const t = userText.toLowerCase();
        // Wide net for natural phrasing — "help with this", "look at
        // this", "what's this", "explain what's on the screen", etc.
        // Required deictic ("this", "that", "here", "on screen") so we
        // don't false-positive on conversational sentences.
        const re = /\b(help|look|explain|what'?s?|what is|describe|tell me about|analy[sz]e)\b[^.?!]*\b(this|that|here|the screen|on (?:my )?screen|the area|the region)\b/;
        if (!re.test(t)) return false;

        // The runResponseCycle caller already claimed the pendingSummons
        // slot for this turn (Ctrl+Space → listening → audio.session_end
        // → onComplete → here, OR wake-with-command → here). We just
        // hand control off to the region overlay and re-use the same
        // ctrl so a hotkey press still cancels cleanly.
        pendingRegionByPebble.set(sidecarId, { userText, ctrl, startedAt: Date.now() });

        await setState(sidecarId, 'working', '');
        try {
          await sidecarManager.dispatchRPC(sidecarId, 'region.start_selection', {});
          console.log(`[ambient-ui] region selection started: "${userText}"`);
        } catch (err) {
          console.warn('[ambient-ui] region.start_selection failed:', err);
          pendingRegionByPebble.delete(sidecarId);
          await speakConfirmation(sidecarId, "I can't capture a region right now.", ctrl);
        }
        return true;
      };

      // T20c — voice-driven in-panel navigation. The dashboard's
      // RoomActionBus already supports `switch_tab` and similar actions
      // for most rooms (workflows, goals, settings, authority, etc.);
      // we broadcast a `room_action` over WS and the panel-mode bridge
      // (PanelRoomActionBridge in AppShellV2) forwards it to whichever
      // room's handler is mounted. Rooms internally validate the tab
      // name and silently reject unknown tabs, so we can be liberal
      // about matching.
      const tryHandleInPanelAction = async (
        sidecarId: string,
        userText: string,
        ctrl: { cancelled: boolean },
      ): Promise<boolean> => {
        const t = userText.toLowerCase();
        // Verbs that mean "navigate inside the current panel". Distinct
        // from "open <room>" (that spawns a new window). The match
        // optionally captures a trailing room hint so "switch to the
        // editor tab in workflows" routes to the workflows panel even
        // when it isn't the most-recent. **Imperative only** — we
        // explicitly reject interrogative phrasings ("show me where the
        // editor tab is"), which should fall through to the LLM with
        // pointer guidance instead of being parsed as a tab-switch.
        if (/\b(where|how|when|which|why|what)\b.*\b(tab|view|section)\b/i.test(t)) {
          return false;
        }
        const re = /\b(?:switch to|go to|jump to|open|click on|select)\s+(?:the\s+)?([a-z][a-z0-9 \-_]{0,30}?)\s+(?:tab|view|section|page)\b(?:\s+(?:in|of)\s+(?:the\s+)?([a-z][a-z ]{0,30}?)(?:\s+(?:window|panel|page))?)?/i;
        const m = re.exec(t);
        if (!m) return false;

        const tabRaw = (m[1] || '').trim();
        const roomHint = (m[2] || '').trim() || undefined;
        if (!tabRaw) return false;

        const target = findPanel(sidecarId, roomHint);
        if (!target) {
          await speakConfirmation(
            sidecarId,
            roomHint
              ? `I don't see a ${roomHint} window open.`
              : "There's no panel open to navigate inside.",
            ctrl,
          );
          return true;
        }

        // Recognized tab synonyms across the dashboard rooms. Match is
        // STRICT — if the captured tab name isn't in this list, fall
        // through to the LLM. Without this, phrases like "open Gmail on
        // a new Chrome tab window" would be parsed as `switch_tab` with
        // tab="gmail_on_a_new_chrome" because the regex captures
        // anything that ends with "… tab".
        const tabSyn: Record<string, string> = {
          editor: 'editor',
          'edit': 'editor',
          'edit view': 'editor',
          builder: 'builder',
          'agent builder': 'agent_builder',
          list: 'list',
          all: 'list',
          logs: 'logs',
          history: 'logs',
          settings: 'settings',
          general: 'general',
          tts: 'tts',
          stt: 'stt',
          voice: 'voice',
          llm: 'llm',
          tools: 'tools',
          channels: 'channels',
        };
        // Disqualify common false-positive contexts: anything mentioning
        // a real browser/window/app makes "tab" almost certainly the
        // browser-tab sense, not a JARVIS panel sub-tab.
        const browserContext = /\b(chrome|firefox|edge|safari|browser|gmail|google|mail|youtube|github|window)\b/i;
        if (browserContext.test(t)) return false;
        const known = tabSyn[tabRaw];
        if (!known) {
          // Captured tab name isn't a known panel sub-tab — fall through
          // to the LLM rather than dispatch a bogus switch_tab.
          return false;
        }
        const tab = known;

        console.log(`[ambient-ui] in-panel action: switch_tab tab="${tab}" on ${target.title} (id=${target.id}${roomHint ? `, hint="${roomHint}"` : ''})`);
        try {
          // The bus broadcasts to all dashboard clients (including all
          // open panels). useRoomActions is keyed on `room`, so only
          // the matching room's handler fires.
          wsService.broadcastRoomAction({
            room: target.key,
            action: 'switch_tab',
            args: { tab },
          });
          await speakConfirmation(sidecarId, `Switched ${target.title} to ${tabRaw}.`, ctrl);
        } catch (err) {
          console.warn('[ambient-ui] in-panel action failed:', err);
          await speakConfirmation(sidecarId, "I couldn't navigate the panel.", ctrl);
        }
        return true;
      };

      // tryHandleSettingsIntent — settings-mutation voice commands.
      // Returns true when the intent was handled (caller skips the LLM).
      const tryHandleSettingsIntent = async (
        sidecarId: string,
        userText: string,
        ctrl: { cancelled: boolean },
      ): Promise<boolean> => {
        const t = userText.toLowerCase();

        // TTS on / off. Match leniently so "turn off text to speech in
        // the settings" hits too — extra trailing words don't break.
        const ttsOff = /\b(turn off|disable|switch off|deactivate)\s+(?:the\s+)?(text[- ]to[- ]speech|tts|voice (?:output|response)?|speech|tts response)\b/.test(t);
        const ttsOn  = /\b(turn on|enable|switch on|activate|reactivate)\s+(?:the\s+)?(text[- ]to[- ]speech|tts|voice (?:output|response)?|speech|tts response)\b/.test(t);
        if (ttsOff) {
          const ok = await applyTTSEnabled(false);
          // Speak the confirmation BEFORE shutting TTS down — temp
          // restore a one-shot provider so the user hears acknowledgment.
          await speakConfirmation(
            sidecarId,
            ok ? "Text-to-speech turned off." : "I couldn't save that setting.",
            ctrl,
          );
          return true;
        }
        if (ttsOn) {
          const ok = await applyTTSEnabled(true);
          await speakConfirmation(
            sidecarId,
            ok ? "Text-to-speech turned on." : "I couldn't save that setting.",
            ctrl,
          );
          return true;
        }

        // STT provider switch.
        const sttMatch =
          /\b(switch|change)\s+(?:the\s+)?(stt|speech[- ]to[- ]text|transcription|speech recognition|listening)\s+(?:to|provider to)\s+(openai|whisper|groq|sarvam|local|usejarvis|use jarvis|jarvis)\b/.exec(t) ||
          /\buse\s+(openai|whisper|groq|sarvam|local|usejarvis|use jarvis|jarvis)\s+(?:for\s+(?:stt|speech[- ]to[- ]text|transcription|speech recognition|listening|hearing))\b/.exec(t);
        if (sttMatch) {
          // 'whisper' → openai; 'jarvis' / 'use jarvis' (how STT typically
          // transcribes the brand name) → the hosted usejarvis provider.
          type SttTarget = 'openai' | 'groq' | 'sarvam' | 'local' | 'usejarvis';
          const canonical = (name: string): SttTarget =>
            (name === 'whisper' ? 'openai' : name === 'use jarvis' || name === 'jarvis' ? 'usejarvis' : name) as SttTarget;
          let target = canonical(sttMatch[2]!);
          // The first capture group depends on which alternative matched.
          const candidate = (sttMatch[3] || sttMatch[1]) as string;
          if (candidate && /^(openai|whisper|groq|sarvam|local|usejarvis|use jarvis|jarvis)$/.test(candidate)) {
            target = canonical(candidate);
          }
          const ok = await applySTTProvider(target);
          await speakConfirmation(
            sidecarId,
            ok
              ? `Switched transcription to ${target}.`
              : `I couldn't switch to ${target} — it may not have an API key configured.`,
            ctrl,
          );
          return true;
        }

        return false;
      };

      // T18 / T18b — voice-triggered panel control. The daemon checks
      // every user-text against a set of intents before running it through
      // the LLM. On a hit we dispatch the right `panel.*` RPC and skip the
      // LLM — saves 2–7 s for trivial commands. Intents:
      //   • open  <room>  — spawn the panel (T18)
      //   • close <room>  — close it
      //   • expand|maximize|fullscreen|make it bigger — set last-spawned
      //     panel to maximized
      //   • minimize|hide it|put it away — set last-spawned panel minimized
      //   • restore|shrink|make it smaller|normalize — set normal state
      //   • focus|where did it go|bring it back — focus last-spawned panel
      // "It / the window / that" pronouns refer to the most-recently-
      // spawned panel for this sidecar, tracked in `lastPanelBySidecar`.
      type RoomMeta = { aliases: string[]; title: string; w: number; h: number; alwaysOnTop?: boolean };
      const ROOMS: Record<string, RoomMeta> = {
        settings:    { aliases: ['settings', 'preferences'],                title: 'Settings',    w: 560, h: 600 },
        workflows:   { aliases: ['workflows', 'workflow', 'flows'],         title: 'Workflows',   w: 900, h: 600 },
        memory:      { aliases: ['memory', 'vault', 'knowledge'],           title: 'Memory',      w: 480, h: 700 },
        tools:       { aliases: ['tools', 'tool catalog', 'tool catalogue'],title: 'Tools',       w: 560, h: 600 },
        agents:      { aliases: ['agents', 'agent monitor'],                title: 'Agents',      w: 600, h: 600 },
        agent_strip: { aliases: ['agent strip', 'agents strip', 'agent panel', 'agent dock', 'background agents'], title: 'Agent Strip', w: 290, h: 440, alwaysOnTop: true },
        authority:   { aliases: ['authority', 'approvals', 'permissions'],  title: 'Authority',   w: 480, h: 600 },
        logs:        { aliases: ['logs', 'log stream', 'log'],              title: 'Logs',        w: 800, h: 500 },
        calendar:    { aliases: ['calendar', 'schedule'],                   title: 'Calendar',    w: 720, h: 600 },
        goals:       { aliases: ['goals', 'okrs', 'goal'],                  title: 'Goals',       w: 600, h: 600 },
        tasks:       { aliases: ['tasks', 'todos', 'task list', 'task'],    title: 'Tasks',       w: 500, h: 600 },
        content:     { aliases: ['content', 'content pipeline', 'notes'],   title: 'Content',     w: 800, h: 600 },
        workspaces:  { aliases: ['workspaces', 'workspace', 'sites'],       title: 'Workspaces',  w: 800, h: 600 },
        usage:       { aliases: ['token usage', 'usage room'],              title: 'Usage',       w: 800, h: 600 },
      };

      // Match aliases longest-first so "tool catalog" wins over "tools" when
      // both appear in the input.
      const orderedAliases: { alias: string; key: string }[] = [];
      for (const [key, meta] of Object.entries(ROOMS)) {
        for (const alias of meta.aliases) orderedAliases.push({ alias, key });
      }
      orderedAliases.sort((a, b) => b.alias.length - a.alias.length);

      const dashboardURL = (key: string): string => {
        // _panel_<key> renders ONLY the RoomBody inside the spawned native
        // window (no AppShell, no voice handlers) so the pebble's sidecar-
        // side voice loop is the single voice surface — no double voice.
        // Use _room_<key> in the dashboard SPA when the user wants the full
        // takeover with thread + rail context.
        return `${pebblePanelOrigin}/#/_panel_${key}`;
      };

      // W3-T3 — restore last-known bounds for a room (voice / palette
      // open). Saved values come from `~/.jarvis/window-state.json`,
      // populated by the panel.bounds_changed handler above. Fallback
      // is the room's catalog default with a sentinel x/y of -1 so the
      // sidecar picks a position near the cursor (the existing behaviour
      // for first-ever opens). Saved positions are NOT clamped here —
      // doing so requires knowing the active monitor layout from the
      // sidecar, which we don't have inline. Off-monitor saves still
      // work because Win11 re-snaps windows whose top-left lands in the
      // void to the primary monitor; the worst case is a one-time
      // re-position on the next user drag, which immediately re-saves.
      const boundsForRoom = (key: string, fallbackW: number, fallbackH: number): { x: number; y: number; w: number; h: number } => {
        const saved = (windowState).getRoomBounds(key);
        if (saved) return saved;
        return { x: -1, y: -1, w: fallbackW, h: fallbackH };
      };

      // Per-sidecar list of currently-open panels (oldest first; LAST is
      // the most recent). We resolve pronoun commands ("expand it") to
      // the last entry, and named commands ("expand the workflows
      // window") by searching back-to-front for a matching key — so
      // when two of the same room are open, the most-recent one wins.
      type PanelEntry = { id: string; key: string; title: string };
      const panelsBySidecar = new Map<string, PanelEntry[]>();
      const trackPanel = (sidecarId: string, entry: PanelEntry): void => {
        const list = panelsBySidecar.get(sidecarId) ?? [];
        list.push(entry);
        panelsBySidecar.set(sidecarId, list);
      };
      const untrackPanel = (sidecarId: string, id: string): void => {
        const list = panelsBySidecar.get(sidecarId);
        if (!list) return;
        const idx = list.findIndex(e => e.id === id);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) panelsBySidecar.delete(sidecarId);
      };

      // W3-T2 — persist per-room window bounds to ~/.jarvis/window-state.json
      // so reopening a room lands it where the user last left it. Bounds
      // come from the sidecar's 1 Hz poll as `panel.bounds_changed`
      // events; we resolve panel id → room key against the tracked
      // inventory above (palette + voice opens both register here).
      const windowState = await import('./window-state.ts');
      const { setRoomBounds } = windowState;
      sidecarManager.onEvent((sidecarId, event) => {
        if (event.event_type !== 'panel.bounds_changed') return;
        const payload = (event.payload ?? {}) as { panel_id?: string; x?: number; y?: number; w?: number; h?: number };
        if (!payload.panel_id || typeof payload.x !== 'number' || typeof payload.y !== 'number'
            || typeof payload.w !== 'number' || typeof payload.h !== 'number') {
          return;
        }
        const list = panelsBySidecar.get(sidecarId);
        const tracked = list?.find((e) => e.id === payload.panel_id);
        if (!tracked) return; // untracked panel (e.g. palette itself) — don't persist
        setRoomBounds(tracked.key, { x: payload.x, y: payload.y, w: payload.w, h: payload.h });
      });

      // W4 — Cmd+K palette: cursor-anchored fuzzy room picker. The
      // sidecar's Ctrl+K hotkey emits a `pebble.palette` event with the
      // current cursor position; the daemon spawns a small `_palette`
      // panel near the cursor (or focuses the existing one). Picks
      // (room nav / object) come back via HTTP `/api/palette/pick`,
      // routed through the palette handler registered below.
      //
      // We deliberately do NOT toggle close on hotkey re-press. webview_go
      // becomes unstable under rapid panel close→spawn cycles (segfault
      // inside webview.Bind on the 3rd–4th panel in quick succession).
      // Closing happens only via Esc / click-outside / pick — all of
      // which include user-action latency, giving WebView2 time to
      // clean up before any new spawn. A small cooldown after close
      // adds a final safety margin.
      const palettePanelBySidecar = new Map<string, { id: string; sidecarId: string }>();
      const lastPaletteCloseAt = new Map<string, number>();

      // Untrack a panel as soon as its window closes (user close button or a
      // Close() RPC) so the inventory used for voice targeting, bounds
      // persistence, and LLM context never points at a window that's gone.
      sidecarManager.onEvent((sidecarId, event) => {
        if (event.event_type !== 'panel.closed') return;
        const payload = (event.payload ?? {}) as { panel_id?: string };
        if (!payload.panel_id) return;
        untrackPanel(sidecarId, payload.panel_id);
        const pal = palettePanelBySidecar.get(sidecarId);
        if (pal && pal.id === payload.panel_id) palettePanelBySidecar.delete(sidecarId);
      });

      // When a sidecar disconnects, drop the per-sidecar pebble/panel state it
      // owned so the maps don't grow across reconnects and stale ids aren't
      // dispatched to a dead connection. (spawnedOn / pendingSummons /
      // subPebbleSlots are cleared by the dedicated handlers above.)
      sidecarManager.onSidecarDisconnected((sidecarId) => {
        panelsBySidecar.delete(sidecarId);
        palettePanelBySidecar.delete(sidecarId);
        lastPaletteCloseAt.delete(sidecarId);
        const eyeTimer = eyeTimers.get(sidecarId);
        if (eyeTimer) { clearTimeout(eyeTimer); eyeTimers.delete(sidecarId); }
        const region = pendingRegionByPebble.get(sidecarId);
        if (region) { region.ctrl.cancelled = true; pendingRegionByPebble.delete(sidecarId); }
        regionCycleActive.delete(sidecarId);
        if (activePebbleSidecar === sidecarId) activePebbleSidecar = null;
        // Sub-pebble bookkeeping is keyed by taskId — drop entries this sidecar owned.
        for (const [taskId, owner] of subPebbleSidecar) {
          if (owner === sidecarId) {
            subPebbleSidecar.delete(taskId);
            subPebbleExpanded.delete(taskId);
          }
        }
      });

      const PALETTE_REOPEN_COOLDOWN_MS = 350;
      const PALETTE_W = 460;
      const PALETTE_H = 440;
      const paletteURL = (): string => {
        return `${pebblePanelOrigin}/#/_palette`;
      };
      const closePalettePanel = async (sidecarId: string): Promise<void> => {
        const entry = palettePanelBySidecar.get(sidecarId);
        if (!entry) return;
        palettePanelBySidecar.delete(sidecarId);
        lastPaletteCloseAt.set(sidecarId, Date.now());
        try {
          await sidecarManager.dispatchRPC(entry.sidecarId, 'panel.close', { id: entry.id });
        } catch (err) {
          console.warn(`[palette] panel.close(${entry.id}) failed:`, err);
        }
      };
      const openPalettePanel = async (sidecarId: string, cursorX: number, cursorY: number): Promise<void> => {
        // Anchor the panel near the cursor with a small offset so the
        // palette doesn't hide the pointer. -1 sentinels would centre it,
        // but here we want it cursor-adjacent.
        const x = Math.max(0, cursorX - 24);
        const y = Math.max(0, cursorY + 18);
        try {
          const result = await sidecarManager.dispatchRPC(sidecarId, 'panel.spawn', {
            url: paletteURL(),
            title: 'Palette',
            bounds: { x, y, w: PALETTE_W, h: PALETTE_H },
            resizable: false,
            always_on_top: true,
            multi_instance: false,
          });
          console.log(`[palette] panel.spawn returned`, result);
          const id = (result && typeof result === 'object' && 'id' in (result as object))
            ? String((result as { id?: unknown }).id ?? '')
            : '';
          if (id) {
            palettePanelBySidecar.set(sidecarId, { id, sidecarId });
            console.log(`[palette] tracked panel id=${id}`);
          } else {
            console.warn(`[palette] panel.spawn returned no id:`, result);
          }
        } catch (err) {
          console.warn(`[palette] panel.spawn failed:`, err);
        }
      };

      // Register the palette handler the api-routes module forwards into
      // when the dashboard's `_palette` page POSTs a pick / close. The
      // pick handler reuses the same panel.spawn path that voice "open
      // workflows" uses, so the room shows up tracked in panelsBySidecar
      // exactly the same way.
      const { setPaletteHandler } = await import('./palette-controller.ts');
      setPaletteHandler({
        async pick({ kind, key }) {
          if (kind !== 'room') return; // object picks not yet wired in panel mode
          const meta = ROOMS[key];
          if (!meta) {
            console.warn(`[palette] pick: unknown room "${key}"`);
            return;
          }
          // Pick the sidecar whose palette is currently open. Fall back
          // to the first sidecar if state is missing (dashboard-only
          // dev path).
          let sidecarId: string | null = null;
          for (const [sid] of palettePanelBySidecar) { sidecarId = sid; break; }
          if (!sidecarId) {
            const list = sidecarManager.listSidecars();
            sidecarId = list.find((s) => s.connected)?.id ?? null;
          }
          if (!sidecarId) return;
          // Close palette before spawning the room so the focus doesn't
          // bounce. Spawn returns an `id` we track for window-mgmt
          // commands.
          await closePalettePanel(sidecarId);
          try {
            const result = await sidecarManager.dispatchRPC(sidecarId, 'panel.spawn', {
              url: dashboardURL(key),
              title: meta.title,
              bounds: boundsForRoom(key, meta.w, meta.h),
              resizable: true,
              always_on_top: meta.alwaysOnTop ?? false,
              multi_instance: false,
            });
            const id = (result && typeof result === 'object' && 'id' in (result as object))
              ? String((result as { id?: unknown }).id ?? '')
              : '';
            if (id) trackPanel(sidecarId, { id, key, title: meta.title });
          } catch (err) {
            console.warn(`[palette] panel.spawn(${key}) from pick failed:`, err);
          }
        },
        async close() {
          // Close the palette on whichever sidecar has it open.
          for (const [sid] of palettePanelBySidecar) {
            await closePalettePanel(sid);
          }
        },
      });

      // W4 — Ctrl+K opens or refocuses the palette. Closing flows
      // through user-driven paths (Esc / click / pick → /api/palette/close),
      // not the hotkey, because rapid hotkey-toggle close→spawn reliably
      // crashes webview_go's Bind path after the 3rd–4th cycle.
      sidecarManager.onEvent(async (sidecarId, event) => {
        if (event.event_type !== 'pebble.palette') return;
        console.log(`[palette] received pebble.palette event from ${sidecarId}, payload=`, event.payload);
        const existing = palettePanelBySidecar.get(sidecarId);
        if (existing) {
          console.log(`[palette] already open (panel id=${existing.id}) — focusing instead of toggling`);
          try {
            await sidecarManager.dispatchRPC(sidecarId, 'panel.focus', { id: existing.id });
          } catch (err) {
            console.warn(`[palette] panel.focus(${existing.id}) failed:`, err);
          }
          return;
        }
        // Cooldown after a recent close — webview_go needs a moment to
        // tear down WebView2 controllers before a new instance is safe.
        const lastClose = lastPaletteCloseAt.get(sidecarId) ?? 0;
        const sinceClose = Date.now() - lastClose;
        if (sinceClose < PALETTE_REOPEN_COOLDOWN_MS) {
          const wait = PALETTE_REOPEN_COOLDOWN_MS - sinceClose;
          console.log(`[palette] cooldown — waiting ${wait}ms before respawn`);
          await new Promise((r) => setTimeout(r, wait));
        }
        const payload = (event.payload ?? {}) as { cursor_x?: number; cursor_y?: number };
        const cx = typeof payload.cursor_x === 'number' ? payload.cursor_x : 200;
        const cy = typeof payload.cursor_y === 'number' ? payload.cursor_y : 200;
        console.log(`[palette] spawning palette at cursor (${cx},${cy})`);
        await openPalettePanel(sidecarId, cx, cy);
      });
      // T20b — render the open-panels inventory as a system-prompt
      // fragment for the LLM. Without this the agent gets the user text
      // but no idea what windows exist, so "switch to the editor tab in
      // workflows" reads as nonsense. With it the LLM can reason about
      // which panel the user means and respond intelligibly. The "most
      // recent" panel is flagged so deictic references ("this", "the
      // window") have a default referent.
      // T9 — capture the user's current screen so the LLM can SEE it
      // when they ask "where is X?" / "show me Y" / "point to Z". Without
      // this the LLM is guessing coordinates from app conventions; with
      // it, it can pick the actual pixel location of the button. Returns
      // null on timeout/failure (best-effort).
      const NEEDS_SCREENSHOT = /\b(where|show me|show where|point (?:to|at)|guide (?:me )?to|find (?:me )?(?:the )?|highlight|locate|tell me where|how (?:do I|to)\s+(?:open|get to|find|see|access|click|reach|use|run|do|start|enable|disable|turn on|turn off)|what'?s? (?:on|on my) (?:my )?screen|what (?:am I|are we) looking at|what (?:do you|can you) see|what'?s? (?:this|happening here)|describe (?:my |the )?screen|read (?:my |the )?screen)\b/i;
      type ScreenshotInfo = {
        base64: string;
        mediaType: string;
        // Scale factors: pixels-on-actual-screen ÷ pixels-in-sent-image.
        // The LLM picks coordinates in the (downscaled) image; we
        // multiply its (x, y) by these before dispatching pebble.point_at
        // so the pebble lands at the real-screen position. =1 when the
        // image wasn't resized.
        scaleX: number;
        scaleY: number;
        origWidth: number;
        origHeight: number;
        sentWidth: number;
        sentHeight: number;
      };
      const fetchScreenshot = async (sidecarId: string): Promise<ScreenshotInfo | null> => {
        try {
          const result = await Promise.race<unknown>([
            // compact: true → sidecar downscales to ≤1600 wide and
            // re-encodes as JPEG (q=80). Keeps the round-trip well under
            // the 16 MB WS limit and within vision-LLM-friendly sizes
            // while still resolving button text legibly.
            sidecarManager.dispatchRPC(sidecarId, 'capture_screen', { compact: true, max_width: 1600, jpeg_quality: 80 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
          ]);
          const obj = result as Record<string, unknown> | undefined;
          const binary = obj?._binary as { data?: string; mime_type?: string } | undefined;
          if (!binary?.data) return null;
          const sentWidth = Number(obj?.width ?? 0) || 0;
          const sentHeight = Number(obj?.height ?? 0) || 0;
          const origWidth = Number(obj?.orig_width ?? 0) || sentWidth;
          const origHeight = Number(obj?.orig_height ?? 0) || sentHeight;
          const scaleX = sentWidth > 0 ? origWidth / sentWidth : 1;
          const scaleY = sentHeight > 0 ? origHeight / sentHeight : 1;
          return {
            base64: binary.data,
            mediaType: binary.mime_type || 'image/jpeg',
            scaleX,
            scaleY,
            origWidth,
            origHeight,
            sentWidth,
            sentHeight,
          };
        } catch (err) {
          console.warn('[ambient-ui] capture_screen failed:', err);
          return null;
        }
      };

      // T20b — query the sidecar for the currently focused OS window
      // (Chrome tab, VSCode, CapCut, etc.) so the LLM can answer
      // "where do I click for X?" without the user having to specify
      // the app. Returns null on any failure — best-effort context.
      const fetchForegroundApp = async (sidecarId: string): Promise<{ title: string; processName?: string } | null> => {
        try {
          const result = await Promise.race<unknown>([
            sidecarManager.dispatchRPC(sidecarId, 'list_windows', {}),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 800)),
          ]);
          const arr = Array.isArray(result) ? result : (result as { windows?: unknown }).windows;
          if (!Array.isArray(arr)) return null;
          for (const w of arr) {
            const ww = w as Record<string, unknown>;
            if (ww.is_foreground) {
              const title = String(ww.title ?? '').trim();
              const processName = ww.process_name ? String(ww.process_name) : undefined;
              if (!title && !processName) return null;
              return { title, processName };
            }
          }
          return null;
        } catch {
          return null;
        }
      };

      const buildPanelContext = async (sidecarId: string): Promise<string> => {
        const list = panelsBySidecar.get(sidecarId);
        const lines = (list ?? []).map((p, i) => {
          const recency = i === (list ?? []).length - 1 ? '  [most recent / likely focus]' : '';
          return `  - ${p.title} (room_key="${p.key}", id="${p.id}")${recency}`;
        });
        const hasPanels = (list ?? []).length > 0;
        const foreground = await fetchForegroundApp(sidecarId);
        // Always emit the [POINT:..] guidance when the pebble channel is
        // active — it's a capability available regardless of whether
        // panels are open. Keep token cost low by only listing panels
        // when there are some.
        const sections: string[] = [];

        // Action-execution directives. Every cycle through here is a
        // voice command — the user already authorized whatever they
        // asked for by saying it out loud. The model has been observed
        // adding extra "may I?" rounds and giving up halfway through
        // multi-step desktop actions; these directives short-circuit
        // both failure modes.
        sections.push(
          '# Acting on the user\'s machine — execute, don\'t ask',
          '',
          'A spoken request IS the authorization. When the user says "click X", "open Y", "send Z", "type ...", just DO it. Do not reply with "I need your permission first" / "shall I go ahead?" / "do you want me to ...?" — the user already said yes by speaking the request. The only exception is genuinely irreversible operations (deleting files, sending money, posting publicly to recipients) — for those, ask once. Clicking icons, opening apps, focusing windows, switching tabs, taking screenshots, navigating URLs are NOT in that category.',
          '',
          '**Prefer the efficient automation path — never click via the OS cursor when there\'s a structured alternative.**',
          '',
          '  - **Web apps** (Gmail, Notion, GitHub, the JARVIS dashboard, anything in a browser): use `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type`. These dispatch DOM events through CDP — no OS cursor involved, very reliable, very fast. The user can keep using their mouse for other things while you operate the page.',
          '',
          '  - **Native Windows apps** (Notepad, File Explorer, settings, dialogs, menus): `desktop_snapshot` to enumerate UI elements, then `desktop_click({element_id})`. Win32 UIA invokes the element directly via COM patterns where possible — no cursor move when the widget supports the Invoke pattern.',
          '',
          '  - **Open an app**: `desktop_launch_app({name: "Chrome"})` is faster and more reliable than clicking a desktop icon. Only fall back to clicking icons if launch_app doesn\'t resolve the app.',
          '',
          'The pebble is a *visual narrator only* — it flies to the action target so the user can see what JARVIS is doing, but it does NOT control the user\'s cursor. The user keeps full mouse freedom while you operate apps through the structured paths above.',
          '',
          'When the user asks for something that genuinely requires a click on a non-UIA surface (desktop icon, system tray, popup), prefer asking them to do it themselves rather than wrestling with coordinate clicks — coordinate clicks move the OS cursor and steal control from the user.',
          '',
          '**Sidecar is primary.** The Go sidecar is connected and exposes desktop / browser / filesystem / clipboard / system_info / screenshot capabilities. Tools auto-route to it — you never need to specify a `target` parameter unless you want to override. If a tool returns "Sidecar not running" / "Desktop bridge not found", that\'s the legacy local-only path leaking through; mention it in your reply but try the same call again — the auto-route should pick up the connected sidecar on the second attempt.',
          '',
          'When you finish a multi-step task, give a short verbal confirmation ("Done — Chrome is up.") rather than re-narrating each step. The pebble already showed each step visually.',
          '',
        );

        if (foreground) {
          sections.push(
            '# Foreground app on the user\'s screen',
            `The user is currently looking at: **${foreground.title || foreground.processName || 'unknown'}**` +
              (foreground.processName ? ` (process: ${foreground.processName})` : ''),
            '',
            'When they say "this", "here", "the window", "this app" without naming a JARVIS panel, they likely mean THIS foreground window. If they ask "where do I click for X?" or "show me Y", reason from this app\'s typical UI: e.g. Chrome\'s close button is in the top-right, VSCode\'s file explorer is the leftmost icon in the activity bar, CapCut\'s timeline is along the bottom. Emit a `[POINT:x,y:label]` tag with your best estimate based on the app and the user\'s screen layout. If the request is ambiguous between the foreground app and a JARVIS panel, prefer the foreground app unless they reference a JARVIS room by name.',
            '',
          );
        }
        if (hasPanels) {
          sections.push(
            '# JARVIS dashboard panels currently open as native windows',
            'The user has these dashboard panels visible on their desktop:',
            ...lines,
            '',
            "Treat short or pronoun-laden references (\"the workflows\", \"this panel\", \"the editor tab\", \"the settings\", \"that window\") as pointing at one of these panels — usually the most recent one unless context says otherwise. Each panel contains the SAME UI the dashboard's matching room would: e.g. workflows has List/Editor/Logs sub-views, memory has the vault tree, settings has TTS/STT toggles. The user can interact with them like any normal app window.",
            '',
            "You CAN: spawn, expand, minimize, restore, focus, and close panels via voice — the user already knows these commands. You CAN switch tabs inside a panel by voice (the user can say \"switch to the editor tab\") — that's already wired.",
            '',
          );
        }
        sections.push(
          '# Pointing at things on the user\'s screen — REQUIRED for "where" / "show me" requests',
          'Emit a tag of the form `[POINT:<x>,<y>:<short label>]` anywhere in your reply to fly the pebble to that screen coordinate. The daemon strips these tags before display + TTS, dispatches a pebble.point_at RPC, and the pebble eases to the position with the label shown in its bubble for ~3.5 seconds. Coordinates are virtual-screen pixels.',
          '',
          '**When the user asks a spatial question, the daemon attaches a screenshot of their current screen as the FIRST content block of the user message.** Use the actual pixels in that image to pick coordinates — read button labels, identify positions, find the exact target the user is asking about. Do NOT fall back to remembered coordinates from prior turns; ground every estimate in the current screenshot.',
          '',
          '**Coordinate space — read it off the grid.** The attached screenshot has a labelled coordinate grid overlay — light vermilion hairlines every 100 px and labelled major lines every 200 px ("x=200", "y=400" …). Pick coordinates in the *image* coordinate space using the grid as your reference frame. Do NOT eyeball pixel positions — find the gridlines that bracket the target element, then interpolate. For a button sitting just left of the "x=1500" gridline at roughly half the distance to "x=1400", you write `x=1450`. Use the same approach for y. The daemon scales your image-space coords back to real-screen pixels before dispatching the pebble, so if you see the close button just left of the "x=1580, y=10" intersection, emit `[POINT:1578,12:close]`.',
          '',
          '**Common coordinate mistakes to avoid:**',
          '- Outputting "real screen" coordinates (e.g. (3792, 29) for a 4K screen) — the LLM sees the SHRUNK image, so coordinates must be in shrunk-image space. The daemon does the upscale.',
          '- Putting coordinates near the centre of the image when the user asked about a corner element. Read the grid: top-right means high x AND low y.',
          '- Reusing example coordinates from these instructions verbatim instead of measuring from the actual screenshot.',
          '',
          '**Required for any request matching:** "where is X", "where do I click for X", "show me X", "point to X", "guide me to X". A reply without the tag for these is wrong — describing the location verbally is not enough; the pebble must actually move.',
          '',
          '**Emit ONE point per request, not a multi-step walkthrough** — unless the user explicitly asks for steps ("walk me through", "show me each step"). If the user asks "how to open a terminal" you point at ONE primary control (the Terminal menu), not three sequential ones.',
          '',
          '**Each request is independent.** Do NOT carry over coordinates or labels from earlier turns; pick fresh ones based on what the user is asking about RIGHT NOW.',
          '',
          'Estimating coordinates: use the foreground-app context above and your knowledge of typical UIs. The user\'s desktop coordinate space starts at (0, 0) top-left. A maximized window on a 1920×1080 screen has its close button near (1895, 8). Browser tab close ≈ right edge of the active tab. Editors typically have their main menu bar around y=10–30. When in doubt, your best guess is fine — the user can re-ask.',
          '',
          'Examples (do not reuse these coordinates verbatim — they\'re illustrative):',
          '  user: "where do I click to publish?" → "Top-right of the workflows panel. [POINT:<x>,<y>:publish]"',
          '  user: "show me where to close this window" → "Top-right of the title bar. [POINT:<x>,<y>:close]"',
          '',
          'Replace `<x>,<y>` with your actual estimate. The text is spoken; the [POINT:..] tag is consumed by the daemon and never shown.',
        );
        return sections.join('\n');
      };

      const findPanel = (sidecarId: string, hint?: string): PanelEntry | null => {
        const list = panelsBySidecar.get(sidecarId);
        if (!list || list.length === 0) return null;
        if (!hint) return list[list.length - 1] ?? null; // pronoun → last
        // Resolve hint to a room key via the alias table.
        let targetKey: string | null = null;
        for (const { alias, key } of orderedAliases) {
          const aliasRe = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
          if (aliasRe.test(hint)) { targetKey = key; break; }
        }
        if (!targetKey) return null;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i]!.key === targetKey) return list[i]!;
        }
        return null;
      };

      // Try to match a window-management intent (expand / minimize /
      // restore / close / focus). Returns null when no intent matches.
      // The `roomHint` captures any explicit room reference in the same
      // utterance ("expand the workflows window") so we can target a
      // specific panel when several are open. Without a hint, the caller
      // resolves to the most-recently-spawned panel.
      type WindowAction = 'maximized' | 'minimized' | 'normal' | 'close' | 'focus';
      const tryParseWindowAction = (text: string): { action: WindowAction; roomHint?: string } | null => {
        const t = text.toLowerCase().trim();
        // Optional trailing room phrase: "the X window", "the X", "X".
        // `(?:[^.!?]*?)` is a tail catch-all up to the first sentence-end,
        // letting the alias matcher inside findPanel pick out the room.
        const roomTail = '(?:\\s+(?:the\\s+|my\\s+)?([a-z][a-z ]{0,40}?)(?:\\s+(?:window|panel|page|view))?)?';

        const verb = (re: string): { action: WindowAction; roomHint?: string } | null => {
          const m = new RegExp(`\\b${re}${roomTail}\\b`, 'i').exec(t);
          if (!m) return null;
          const hint = (m[1] || '').trim();
          // Strip pronouns; only return as hint if it might be a real room name.
          const pronoun = /^(it|that|the window|the panel)$/.test(hint);
          return { action: 'maximized', roomHint: pronoun ? undefined : (hint || undefined) };
        };

        // Maximize / expand / fullscreen
        const maxRes = verb('(?:expand|maximi[sz]e|enlarge|blow it up|go full ?screen|full ?screen)');
        if (maxRes) return { ...maxRes, action: 'maximized' };
        // "make it bigger / fullscreen" — different shape; match separately.
        const makeBig = /\bmake\s+(?:it|that|the window)\s+(?:bigger|big|larger|huge|fullscreen|full ?screen)\b/.exec(t);
        if (makeBig) return { action: 'maximized' };

        // Minimize
        const minRes = verb('(?:minimi[sz]e|hide(?: it| that)?|put it away|tuck it away|send it to (?:the )?taskbar)');
        if (minRes) return { ...minRes, action: 'minimized' };

        // Restore / shrink / normal
        const restoreRes = verb('(?:restore|shrink|un ?maxim(?:i[sz]e)?|normalize|reset (?:the )?(?:window|size)|normal size)');
        if (restoreRes) return { ...restoreRes, action: 'normal' };
        const makeSmall = /\bmake\s+(?:it|that|the window)\s+(?:smaller|small|normal)\b/.exec(t);
        if (makeSmall) return { action: 'normal' };

        // Close (deictic — pronoun-anchored only). Plain "close <room>"
        // stays in the open/close room path so the alias matcher there
        // can drive title-vs-key selection cleanly.
        if (/\b(close it|close that|close the window|close the panel|dismiss( it)?|shut it|kill it|get rid of it|throw it away)\b/.test(t)) {
          return { action: 'close' };
        }

        // Focus / bring back
        const focusRes = verb('(?:focus|raise|surface|bring it (?:back|forward|to the front)|show me the window)');
        if (focusRes) return { ...focusRes, action: 'focus' };
        if (/\bwhere did (?:it|the window) go\b/.test(t)) return { action: 'focus' };

        return null;
      };

      const speakConfirmation = async (sidecarId: string, text: string, ctrl: { cancelled: boolean }) => {
        await setState(sidecarId, 'speaking', text);
        try { wsService.broadcastHeartbeat(text); } catch { /* ignore */ }
        if (pebbleTTS && !ctrl.cancelled) {
          try {
            const audio = await pebbleTTS.synthesize(text);
            await sidecarManager.dispatchRPC(sidecarId, 'pebble.play_audio', {
              data: audio.toString('base64'),
              mime_type: ttsMimeType(jarvisConfig.tts),
              blocking: false,
            });
          } catch (err) {
            console.warn('[ambient-ui] confirmation TTS failed:', err);
          }
        }
        if (ctrl.cancelled) return;
        await new Promise<void>(r => setTimeout(r, Math.max(800, text.length * 60)));
        if (!ctrl.cancelled) await setState(sidecarId, 'idle', '');
      };

      // tryHandleSubPebbleCloseIntent — close one or more backgrounded
      // sub-agents by voice. Matches:
      //   "close (this|that|the) background agent"     → most-recent
      //   "close all background agents" / "close all"  → every active sub-pebble
      //   "close the (amber|sage|...) one"             → close by color
      //   "close the (research|legal|...) one"         → close by agent-name
      //                                                  substring match
      //   "dismiss / kill / get rid of" — same verbs
      // Returns true when handled (skips LLM).
      const tryHandleSubPebbleCloseIntent = async (
        sidecarId: string,
        userText: string,
        ctrl: { cancelled: boolean },
      ): Promise<boolean> => {
        const t = userText.toLowerCase().trim();
        // Cheap pre-filter — needs a close verb + a backgrounded-agent noun.
        if (!/\b(close|dismiss|kill|get rid of|cancel)\b/.test(t)) return false;
        if (!/\b(background|sub.?agent|sub.?pebble|agents?\b)/.test(t) && !/\b(this|that)\b/.test(t)) {
          return false;
        }

        const list = panelsBySidecar; // not used here, but reference kept for parity
        void list;

        // Build the active sub-pebble list from the slot table.
        const used = subPebbleSlots.get(sidecarId);
        if (!used || used.size === 0) {
          await speakConfirmation(sidecarId, "There are no background agents running.", ctrl);
          return true;
        }
        const tm = agentService.getTaskManager();
        if (!tm) return false;

        // Collect candidates: id + spawn order + color + agentName
        type Cand = { id: string; slot: number; color: string; agentName: string };
        const cands: Cand[] = [];
        for (const [id, slot] of used.entries()) {
          const task = tm.getTask(id);
          if (!task) continue;
          cands.push({ id, slot, color: colorForTask(id), agentName: task.agentName });
        }
        if (cands.length === 0) {
          await speakConfirmation(sidecarId, "There are no background agents to close.", ctrl);
          return true;
        }

        const closeOne = async (cand: Cand, label: string): Promise<void> => {
          try {
            await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.close', { id: cand.id });
            const closedSlot = used.get(cand.id);
            used.delete(cand.id);
            subPebbleExpanded.delete(cand.id);
            subPebbleSidecar.delete(cand.id);
            // C2 — slot reflow to keep daemon's slot table aligned with
            // the sidecar's. Each surviving sub-pebble above slot `closedSlot`
            // shifts up by one so the next nextSlot() pick doesn't collide.
            if (closedSlot !== undefined) {
              for (const [otherId, slot] of used.entries()) {
                if (slot > closedSlot) used.set(otherId, slot - 1);
              }
            }
            await speakConfirmation(sidecarId, `Closed the ${label} background agent.`, ctrl);
          } catch (err) {
            console.warn(`[sub-pebble] close ${cand.id} failed:`, err);
            await speakConfirmation(sidecarId, "I couldn't close that background agent.", ctrl);
          }
        };

        // "close all"
        if (/\b(all|every|everything)\b/.test(t) && /\b(background|sub.?agent|agents?|sub.?pebble)/.test(t)) {
          try {
            await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.close_all', {});
            used.clear();
            await speakConfirmation(sidecarId, `Closed all ${cands.length} background ${cands.length === 1 ? 'agent' : 'agents'}.`, ctrl);
          } catch (err) {
            console.warn('[sub-pebble] close_all failed:', err);
            await speakConfirmation(sidecarId, "I couldn't close them.", ctrl);
          }
          return true;
        }

        // Color match — "close the amber one"
        const colorWords = ['amber', 'sage', 'violet', 'mustard', 'teal', 'vermilion'];
        for (const cw of colorWords) {
          if (new RegExp(`\\b${cw}\\b`).test(t)) {
            const match = cands.find(c => c.color === cw);
            if (match) {
              await closeOne(match, cw);
              return true;
            }
          }
        }

        // Agent-name substring match — "close the research one" → matches
        // "Research Analyst", "close the legal" → "Legal Advisor".
        const m = /\bclose (?:the )?([a-z]+)(?:\s+one|\s+agent|\s+background|\s+sub.?agent)?/i.exec(t);
        if (m && m[1]) {
          const hint = m[1].toLowerCase();
          const reserved = new Set(['this', 'that', 'the', 'a', 'an', 'background', 'all', 'every']);
          if (!reserved.has(hint)) {
            const match = cands.find(c => c.agentName.toLowerCase().includes(hint));
            if (match) {
              await closeOne(match, match.agentName.toLowerCase());
              return true;
            }
          }
        }

        // "this" / "that" / "the background agent" — close most recent.
        const newest = cands.slice().sort((a, b) => b.slot - a.slot)[0];
        if (newest) {
          await closeOne(newest, 'most recent');
          return true;
        }
        return false;
      };

      // Keyword routing table — each specialist id maps to phrases that
      // strongly suggest it. Scoring counts how many distinct keywords from
      // each set appear in the (lowercased) task text. Multi-word phrases
      // count as one match. Highest-scoring specialist wins; ties broken
      // by listing order (more-specific specialists first).
      //
      // Keys are the actual role ids from roles/specialists/*.yaml
      // (hyphen-separated). Edit this table when adding a new specialist.
      const SPECIALIST_KEYWORDS: Array<{ id: string; words: string[] }> = [
        { id: 'software-engineer', words: ['code', 'codebase', 'bug', 'refactor', 'debug', 'function', 'implement', 'compile', 'unit test', 'pull request', 'merge', 'git', 'typescript', 'python', 'rust', 'golang', 'api', 'sdk', 'library', 'framework'] },
        { id: 'legal-advisor',     words: ['legal', 'contract', 'nda', 'terms of service', 'privacy policy', 'gdpr', 'hipaa', 'soc 2', 'compliance', 'license', 'copyright', 'trademark', 'lawsuit', 'patent', 'liability', 'agreement', 'clause'] },
        { id: 'financial-analyst', words: ['budget', 'revenue', 'profit', 'p&l', 'roi', 'cost', 'pricing', 'cash flow', 'forecast', 'expense', 'invoice', 'financial', 'finance', 'tax', 'accounting'] },
        { id: 'data-analyst',      words: ['data', 'analyze', 'analysis', 'chart', 'graph', 'metric', 'statistic', 'query', 'dataset', 'csv', 'spreadsheet', 'sql', 'dashboard', 'visualization', 'trend', 'distribution'] },
        { id: 'marketing-strategist', words: ['marketing', 'campaign', 'ad', 'ads', 'advertising', 'brand', 'branding', 'growth', 'seo', 'funnel', 'audience', 'positioning', 'launch strategy', 'go to market', 'gtm', 'conversion'] },
        { id: 'content-writer',    words: ['write', 'draft', 'article', 'blog', 'post', 'copy', 'caption', 'newsletter', 'press release', 'tagline', 'headline', 'script', 'rewrite', 'edit copy'] },
        { id: 'customer-support',  words: ['ticket', 'support', 'complaint', 'refund', 'customer issue', 'help desk', 'reply to customer', 'escalation', 'apology', 'response template'] },
        { id: 'hr-specialist',     words: ['hire', 'recruit', 'interview', 'onboarding', 'job description', 'candidate', 'employee', 'salary', 'compensation', 'performance review'] },
        { id: 'project-coordinator', words: ['deadline', 'milestone', 'schedule', 'sprint', 'gantt', 'project plan', 'timeline', 'kickoff', 'stand up', 'kanban', 'roadmap'] },
        { id: 'system-administrator', words: ['server', 'sysadmin', 'deploy', 'config', 'docker', 'kubernetes', 'k8s', 'nginx', 'apache', 'devops', 'ci', 'cd', 'pipeline', 'firewall', 'ssh'] },
        { id: 'research-analyst',  words: ['research', 'investigate', 'compare', 'summarize', 'overview', 'survey', 'look up', 'find out', 'explore', 'benchmark', 'evaluate', 'review options', 'best', 'top', 'recommend'] },
      ];

      // pickSpecialistForTask returns the best-fit specialist id for a
      // free-form task description. Scores by keyword hits, falls back to
      // research-analyst (the most generic) when nothing scores. Final
      // fallback to the first available specialist when research-analyst
      // isn't in the catalog either.
      const pickSpecialistForTask = (task: string, specialists: Map<string, unknown>): string => {
        const t = task.toLowerCase();
        let bestId = '';
        let bestScore = 0;
        for (const entry of SPECIALIST_KEYWORDS) {
          if (!specialists.has(entry.id)) continue;
          let score = 0;
          for (const w of entry.words) {
            // Word-bounded match so "graph" doesn't fire for "paragraph",
            // and multi-word phrases match as a single hit.
            const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            if (re.test(t)) score++;
          }
          if (score > bestScore) {
            bestScore = score;
            bestId = entry.id;
          }
        }
        if (bestId) return bestId;
        if (specialists.has('research-analyst')) return 'research-analyst';
        return Array.from(specialists.keys())[0] ?? '';
      };

      // tryHandleBackgroundIntent — match "in the background, X" /
      // "background: X" / "spawn a background agent to X" and route X
      // through taskManager.launch as a backgrounded sub-agent. The
      // taskManager lifecycle subscription above will spawn the matching
      // sub-pebble on the rail. Skips the LLM entirely — fast path.
      //
      // Specialist pick: keyword-routed via pickSpecialistForTask above.
      const tryHandleBackgroundIntent = async (
        sidecarId: string,
        userText: string,
        ctrl: { cancelled: boolean },
      ): Promise<boolean> => {
        // Match the trigger phrase + capture everything after.
        const re = /\b(?:in the background[,:]?\s*|background[,:]?\s+|spawn (?:a |an )?background\s+(?:agent|task)\s+(?:to\s+|that\s+)?)(.+)/i;
        const m = re.exec(userText);
        if (!m) return false;
        const task = (m[1] ?? '').trim();
        if (task.length < 3) return false;

        const orchestrator = agentService.getOrchestrator();
        const taskManagerLocal = agentService.getTaskManager();
        const llmManager = agentService.getLLMManager();
        const specialists = agentService.getSpecialists();
        if (!orchestrator || !taskManagerLocal || !llmManager || !specialists || specialists.size === 0) {
          await speakConfirmation(sidecarId, "I can't start a background agent right now.", ctrl);
          return true;
        }

        const deps = {
          orchestrator,
          llmManager,
          specialists,
          taskManager: taskManagerLocal,
        };

        // Smart routing — pick the specialist whose keyword set best
        // matches the task. Falls back to research-analyst (the most
        // generic) when nothing scores. Logs the decision so the user
        // can see why it picked what it picked.
        const specialistId = pickSpecialistForTask(task, specialists);
        if (!specialistId) {
          await speakConfirmation(sidecarId, "No specialists are configured.", ctrl);
          return true;
        }
        console.log(`[background-intent] routed task "${task.slice(0, 60)}…" → ${specialistId}`);

        try {
          const spawned = spawnPersistentAgent(deps, specialistId);
          await assignPersistentAgentTask(deps, { agentId: spawned.agent.id, task, context: '' });
          await speakConfirmation(sidecarId, `Got it. Running in the background.`, ctrl);
          console.log(`[ambient-ui] background-intent: spawned ${specialistId} for "${task.slice(0, 60)}"`);
        } catch (err) {
          console.warn('[ambient-ui] background-intent dispatch failed:', err);
          await speakConfirmation(sidecarId, "I couldn't start that background task.", ctrl);
        }
        return true;
      };

      // tryHandlePanelIntent looks for "open|show|launch <room>" or
      // "close|hide|dismiss <room>" anywhere in the user text. On match
      // it dispatches the right panel RPC, speaks a short confirmation
      // through the same TTS pipeline, and returns true so the caller
      // skips the LLM. Returns false when no intent is recognized.
      const tryHandlePanelIntent = async (
        sidecarId: string,
        userText: string,
        ctrl: { cancelled: boolean },
      ): Promise<boolean> => {
        const lower = userText.toLowerCase();

        // T18b — window-management intents. Either pronoun-anchored
        // ("expand it") or named ("expand the workflows window") — the
        // parser surfaces an optional `roomHint` we resolve via the
        // alias table, falling back to the most-recently-spawned panel.
        const parsed = tryParseWindowAction(lower);
        if (parsed) {
          const { action, roomHint } = parsed;
          const target = findPanel(sidecarId, roomHint);
          if (!target) {
            const reason = roomHint
              ? `I don't see a ${roomHint} window open.`
              : "There's no window open to do that with.";
            await speakConfirmation(sidecarId, reason, ctrl);
            return true;
          }
          console.log(`[ambient-ui] window-action intent: ${action} on ${target.title} (id=${target.id}${roomHint ? `, hint="${roomHint}"` : ''})`);
          try {
            if (action === 'close') {
              await sidecarManager.dispatchRPC(sidecarId, 'panel.close', { id: target.id });
              untrackPanel(sidecarId, target.id);
              await speakConfirmation(sidecarId, `Closed ${target.title}.`, ctrl);
            } else if (action === 'focus') {
              await sidecarManager.dispatchRPC(sidecarId, 'panel.focus', { id: target.id });
              await speakConfirmation(sidecarId, `Here it is.`, ctrl);
            } else {
              // maximized / minimized / normal
              await sidecarManager.dispatchRPC(sidecarId, 'panel.set_window_state', {
                id: target.id,
                state: action,
              });
              const verb = action === 'maximized' ? 'Expanding' : action === 'minimized' ? 'Minimizing' : 'Restoring';
              await speakConfirmation(sidecarId, `${verb} ${target.title}.`, ctrl);
            }
          } catch (err) {
            console.warn(`[ambient-ui] window-action ${action} failed:`, err);
            // The window may have been closed externally — drop our cache
            // so subsequent commands don't keep trying a dead id.
            if (action === 'close' || /unknown panel/i.test(String(err))) {
              untrackPanel(sidecarId, target.id);
            }
            await speakConfirmation(sidecarId, "I couldn't do that with the window.", ctrl);
          }
          return true;
        }

        // Cheap pre-filter for the open/close <room> path.
        if (!/(open|show|launch|bring up|close|hide|dismiss|shut)/.test(lower)) {
          return false;
        }

        // Find the (verb, room) pair. Only match a room alias that follows
        // the verb so "the tools are useful" doesn't open Tools.
        const openRe  = /\b(open|show|launch|bring up|let me see)\s+(?:the\s+|my\s+)?([a-z][a-z ]{0,40})/i;
        const closeRe = /\b(close|hide|dismiss|shut)\s+(?:the\s+|my\s+)?([a-z][a-z ]{0,40})/i;
        const openM = openRe.exec(lower);
        const closeM = closeRe.exec(lower);
        const m = openM || closeM;
        if (!m) return false;
        const roomAction: 'open' | 'close' = openM ? 'open' : 'close';
        const tail = m[2];
        if (!tail) return false;

        let key: string | null = null;
        for (const { alias, key: roomKey } of orderedAliases) {
          // Word-boundary match against the captured tail so "open settings page"
          // matches "settings" cleanly without grabbing the trailing words.
          const aliasRe = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
          if (aliasRe.test(tail)) { key = roomKey; break; }
        }
        if (!key) return false;

        const meta = ROOMS[key]!;
        const confirm = roomAction === 'open' ? `Opening ${meta.title}.` : `Closing ${meta.title}.`;
        console.log(`[ambient-ui] panel intent: ${roomAction} ${key} (matched "${m[0]}")`);

        // Speak the confirmation through the queue-based TTS path so the
        // user hears feedback even before the window finishes spawning.
        await setState(sidecarId, 'thinking', '');
        try { wsService.broadcastHeartbeat(confirm); } catch { /* ignore */ }

        if (roomAction === 'open') {
          try {
            const result = await sidecarManager.dispatchRPC(sidecarId, 'panel.spawn', {
              url: dashboardURL(key),
              title: meta.title,
              bounds: boundsForRoom(key, meta.w, meta.h),
              resizable: true,
              always_on_top: meta.alwaysOnTop ?? false,
              multi_instance: false,
            });
            // panel.spawn returns { id: "<panel-id>" } — track it so
            // window-management commands ("expand it", "close the
            // workflows window") can resolve a target.
            const id = (result && typeof result === 'object' && 'id' in (result as object))
              ? String((result as { id?: unknown }).id ?? '')
              : '';
            if (id) {
              trackPanel(sidecarId, { id, key, title: meta.title });
            }
          } catch (err) {
            console.warn(`[ambient-ui] panel.spawn(${key}) failed:`, err);
          }
        } else {
          // panel.close — resolve the target by room key against our
          // tracker. If multiple panels match (e.g. several workflow
          // windows), close the most recent.
          try {
            const target = findPanel(sidecarId, key);
            if (target) {
              await sidecarManager.dispatchRPC(sidecarId, 'panel.close', { id: target.id });
              untrackPanel(sidecarId, target.id);
            } else {
              console.log(`[ambient-ui] no tracked panel for key "${key}" — close is a no-op`);
            }
          } catch (err) {
            console.warn(`[ambient-ui] panel.close(${key}) failed:`, err);
          }
        }

        if (ctrl.cancelled) return true;

        // Speak the confirmation (single sentence, fits in one TTS clip).
        if (pebbleTTS) {
          try {
            const audio = await pebbleTTS.synthesize(confirm);
            await sidecarManager.dispatchRPC(sidecarId, 'pebble.play_audio', {
              data: audio.toString('base64'),
              mime_type: ttsMimeType(jarvisConfig.tts),
              blocking: false,
            });
          } catch (err) {
            console.warn('[ambient-ui] panel-intent TTS failed:', err);
          }
        }
        await setState(sidecarId, 'speaking', confirm);
        // Hold speaking just long enough for the short confirmation to play.
        const holdMs = Math.max(800, confirm.length * 60);
        await new Promise<void>(r => setTimeout(r, holdMs));
        if (ctrl.cancelled) return true;
        await setState(sidecarId, 'idle', '');
        return true;
      };

      // T26b — resolve coordinates for action-class tools and fly the
      // pebble to the target before the click fires. The orchestrator
      // executes tools AFTER the LLM finishes streaming the message,
      // so dispatching point_at right when we see the tool_call event
      // gives the pebble ~50-300 ms head-start on the actual action —
      // enough for the user to see it land at the button.
      const flyPebbleToToolTarget = async (
        sidecarId: string,
        toolName: string,
        args: Record<string, unknown>,
        label: string,
      ): Promise<void> => {
        try {
          if (toolName === 'desktop_click') {
            const id = Number(args.element_id);
            if (!Number.isFinite(id)) return;
            const { getCachedElementBounds } = await import('../actions/tools/desktop.ts');
            const bounds = getCachedElementBounds(id);
            if (!bounds) return; // not in cache → label-only narration
            const cx = Math.round(bounds.x + bounds.width / 2);
            const cy = Math.round(bounds.y + bounds.height / 2);
            console.log(`[ambient-ui] fly pebble to desktop element [${id}] @ (${cx},${cy})`);
            await sidecarManager.dispatchRPC(sidecarId, 'pebble.point_at', {
              x: cx, y: cy, label, duration_ms: 2500,
            });
          } else if (toolName === 'browser_click' || toolName === 'browser_type') {
            // T26c — fly the pebble to the rendered element in the
            // browser viewport. We bounce a Runtime.evaluate through the
            // sidecar's browser capability to read the element's
            // getBoundingClientRect + window.screenX/Y; the result is
            // already in screen-pixel space so no extra scale step.
            const id = Number(args.element_id);
            if (!Number.isFinite(id)) return;
            const script = `
(function(){
  try {
    var els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], [tabindex]');
    var el = els[${Math.floor(id)}];
    if (!el) return JSON.stringify({error: 'not found'});
    var r = el.getBoundingClientRect();
    return JSON.stringify({
      x: Math.round(r.x + (window.screenX || 0)),
      y: Math.round(r.y + (window.screenY || 0)),
      w: Math.round(r.width),
      h: Math.round(r.height)
    });
  } catch (e) { return JSON.stringify({error: String(e)}); }
})()`;
            try {
              const evalResult = await Promise.race<unknown>([
                sidecarManager.dispatchRPC(sidecarId, 'browser_evaluate', { expression: script }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
              ]);
              // Result shape varies by sidecar — try to dig the JSON
              // string out of common locations.
              let raw: string | null = null;
              if (typeof evalResult === 'string') raw = evalResult;
              else if (evalResult && typeof evalResult === 'object') {
                const r = evalResult as Record<string, unknown>;
                if (typeof r.value === 'string') raw = r.value;
                else if (typeof r.result === 'string') raw = r.result;
                else if (r.result && typeof r.result === 'object') {
                  const rr = r.result as Record<string, unknown>;
                  if (typeof rr.value === 'string') raw = rr.value;
                }
              }
              if (!raw) return;
              let rawStr: string = raw;
              // Sometimes the inner JSON is wrapped in a CDP shape
              // {"type":"string","value":"..."} — try one more peel.
              try {
                const parsed = JSON.parse(rawStr);
                if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string') rawStr = parsed.value;
              } catch { /* not nested */ }
              const bounds = JSON.parse(rawStr) as { x?: number; y?: number; w?: number; h?: number; error?: string };
              if (bounds.error || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return;
              const cx = Math.round(bounds.x + (bounds.w ?? 0) / 2);
              const cy = Math.round(bounds.y + (bounds.h ?? 0) / 2);
              console.log(`[ambient-ui] fly pebble to browser element [${id}] @ (${cx},${cy})`);
              await sidecarManager.dispatchRPC(sidecarId, 'pebble.point_at', {
                x: cx, y: cy, label, duration_ms: 2500,
              });
            } catch (err) {
              console.warn('[ambient-ui] browser bounds fetch failed:', err);
            }
          }
          // browser_click / browser_type / launch_app etc.: no cached
          // bounds → fall through to v1 label-only narration. Browser
          // selector → coords resolution lands in T26c (CDP DOM.getBoxModel).
        } catch (err) {
          console.warn('[ambient-ui] flyPebbleToToolTarget error:', err);
        }
      };

      // T26 — action narration. Tools that perform visible actions on
      // the user's machine (clicks, types, navigations, file ops) get a
      // pebble narration when the LLM emits the call; read-only or
      // introspection tools (read_file, list_*, snapshots, vault
      // queries) are skipped — narrating those would just be noise.
      // Tool names match the canonical names in src/actions/tools/*.ts.
      const NARRATE_TOOLS = /^(browser_(?:click|type|navigate|scroll|evaluate|upload_file)|desktop_(?:click|type|press_keys|launch_app|focus_window)|run_command|write_file|set_clipboard|create_document|delegate_task|manage_workflow|manage_goals|manage_agents)$/;

      const describeToolCall = (name: string, args: Record<string, unknown>): string => {
        const trim = (s: unknown, n = 40) => {
          const str = typeof s === 'string' ? s : String(s ?? '');
          return str.length > n ? str.slice(0, n - 1) + '…' : str;
        };
        switch (name) {
          // Browser
          case 'browser_navigate':    return `Opening ${trim(args.url, 60)}`;
          case 'browser_click':       return `Clicking ${trim(args.text || args.selector || 'element', 50)}`;
          case 'browser_type':        return `Typing into ${trim(args.selector || 'field', 30)}`;
          case 'browser_scroll':      return 'Scrolling';
          case 'browser_evaluate':    return 'Running JS';
          case 'browser_upload_file': return `Uploading ${trim(args.path, 40)}`;
          // Desktop (Win32 UIA)
          case 'desktop_click':        return `Clicking ${trim(args.element_id || args.label || 'element', 50)}`;
          case 'desktop_type':         return `Typing "${trim(args.text, 50)}"`;
          case 'desktop_press_keys':   return `Pressing ${trim(args.keys || args.key, 20)}`;
          case 'desktop_launch_app':   return `Launching ${trim(args.name || args.app || args.path, 40)}`;
          case 'desktop_focus_window': return `Focusing ${trim(args.title || args.window || (args.pid ? `PID ${args.pid}` : 'window'), 40)}`;
          // Filesystem / shell
          case 'run_command':          return `Running ${trim(args.command, 50)}`;
          case 'write_file':           return `Writing ${trim(args.path, 50)}`;
          case 'set_clipboard':        return `Copying to clipboard`;
          case 'create_document':      return `Creating ${trim(args.title || args.path, 40)}`;
          // Agents / workflows / goals
          case 'delegate_task':        return `Delegating to ${trim(args.specialist || args.role, 30)}`;
          case 'manage_workflow':      return `Workflow: ${trim(args.action, 20)}`;
          case 'manage_goals':         return `Goal: ${trim(args.action, 20)}`;
          case 'manage_agents':        return `Agent: ${trim(args.action, 20)}`;
          default:                     return name.replace(/_/g, ' ');
        }
      };

      // T8 — element-pointing tags. The LLM can emit `[POINT:x,y:label]`
      // anywhere in its response. We strip every CLOSED tag from the
      // streamed text before it reaches the bubble or TTS, and dispatch
      // a `pebble.point_at` RPC for each new tag so the pebble flies to
      // the screen position with a label callout. Tags arriving across
      // chunk boundaries are handled because we only match closed tags
      // (the `]` terminator must be present).
      const POINT_TAG_RE = /\[POINT:(-?\d+),(-?\d+):([^\]]+)\]/g;
      const stripPointTags = (
        text: string,
        seen: Set<string>,
        onPoint: (x: number, y: number, label: string) => void,
      ): string => {
        return text.replace(POINT_TAG_RE, (full, x, y, label) => {
          // Only dispatch tags we haven't fired yet this cycle. Match
          // signature is the literal tag text — collisions on identical
          // [POINT:..] in one cycle are harmless (LLM rarely repeats).
          if (!seen.has(full)) {
            seen.add(full);
            onPoint(Number(x), Number(y), String(label).trim());
          }
          return '';
        });
      };

      // extractCompleteSentences pulls full sentences off the head of
      // `buffer` and returns them, leaving any in-progress trailing
      // fragment in `remainder`. A "sentence" here is text terminated by
      // ., !, or ? followed by whitespace. Decimal numbers ("3.14") are
      // safe because the regex requires whitespace after the dot.
      const sentenceBoundary = /([.!?]+)(\s+|$)/g;
      const extractCompleteSentences = (buffer: string): { sentences: string[]; remainder: string } => {
        const sentences: string[] = [];
        let lastEnd = 0;
        sentenceBoundary.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = sentenceBoundary.exec(buffer)) !== null) {
          // Don't treat end-of-buffer match (\s+|$ matched $) as complete
          // — that's an in-progress fragment to keep buffering.
          const matchEnd = m.index + m[0].length;
          if (matchEnd >= buffer.length && m[2] === '') break;
          const chunk = buffer.slice(lastEnd, matchEnd).trim();
          if (chunk) sentences.push(chunk);
          lastEnd = matchEnd;
        }
        return { sentences, remainder: buffer.slice(lastEnd) };
      };

      // stripMarkdownForSpeech flattens markdown to plain prose so TTS doesn't
      // read syntax aloud ("asterisk asterisk", "hash hash"). The bubble still
      // receives the raw markdown (the sidecar renders it styled); only the
      // synthesized audio gets the cleaned text.
      const stripMarkdownForSpeech = (s: string): string =>
        s
          .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
          .replace(/`([^`]*)`/g, '$1')              // inline code
          .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links -> text
          .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // ATX headings
          .replace(/^\s{0,3}>\s?/gm, '')            // blockquote markers
          .replace(/^\s*[-*+]\s+/gm, '')            // bullet markers
          .replace(/^\s*\d+[.)]\s+/gm, '')          // numbered markers
          .replace(/(\*\*|__)(.*?)\1/g, '$2')       // bold
          .replace(/(\*|_)(.*?)\1/g, '$2')          // italic
          .replace(/~~(.*?)~~/g, '$1')              // strikethrough
          .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')    // horizontal rules
          .replace(/\|/g, ' ')                      // table pipes
          .replace(/\s+/g, ' ')
          .trim();

      // runResponseCycle — streams the LLM response token-by-token.
      // Each completed sentence is synthesized and queued on the sidecar
      // immediately so playback starts within ~1 s of the LLM's first
      // sentence (rather than waiting for the entire response). Bubble
      // text grows live with the stream — the typewriter is now the
      // LLM's natural cadence. Sidecar's playback queue plays clips
      // back-to-back; we track estimated end-of-playback so we know
      // when to flip to idle.
      const runResponseCycle = async (
        sidecarId: string,
        userText: string,
        ctrl: { cancelled: boolean },
        opts?: { image?: { base64: string; mediaType: string } },
      ): Promise<void> => {
        const cycleStart = Date.now();
        // Mark this machine as the one in use so any background task launched
        // during this turn attaches its sub-pebble here (single active machine).
        activePebbleSidecar = sidecarId;

        // Fast paths (skip the LLM entirely). Skipped when an image is
        // already attached — the region-captured re-entry path lands
        // here too and shouldn't try to trigger region capture again.
        if (!opts?.image) {
          if (await tryHandleRegionIntent(sidecarId, userText, ctrl)) {
            console.log(`[ambient-ui] region-intent fast path took ${Date.now() - cycleStart}ms (waiting for capture…)`);
            return;
          }
        }
        if (await tryHandleSettingsIntent(sidecarId, userText, ctrl)) {
          console.log(`[ambient-ui] settings-intent fast path took ${Date.now() - cycleStart}ms`);
          return;
        }
        if (await tryHandleInPanelAction(sidecarId, userText, ctrl)) {
          console.log(`[ambient-ui] in-panel-action fast path took ${Date.now() - cycleStart}ms`);
          return;
        }
        if (await tryHandleSubPebbleCloseIntent(sidecarId, userText, ctrl)) {
          console.log(`[ambient-ui] sub-pebble-close fast path took ${Date.now() - cycleStart}ms`);
          return;
        }
        if (await tryHandleBackgroundIntent(sidecarId, userText, ctrl)) {
          console.log(`[ambient-ui] background-intent fast path took ${Date.now() - cycleStart}ms`);
          return;
        }
        if (await tryHandlePanelIntent(sidecarId, userText, ctrl)) {
          console.log(`[ambient-ui] panel-intent fast path took ${Date.now() - cycleStart}ms`);
          return;
        }

        await setState(sidecarId, 'thinking', '');
        // Clear any stale overflow button from the previous response
        // before this one starts streaming. Best-effort; sidecar without
        // pebble cap silently ignores.
        sidecarManager.dispatchRPC(sidecarId, 'pebble.set_answer_overflow', { answer_id: '' })
          .catch(() => { /* ignore */ });

        let firstTokenAt = 0;
        let firstAudioDispatchAt = 0;
        let visibleText = '';
        let unsynth = '';
        let speakingStarted = false;
        let speakingFlipPending: Promise<void> | null = null;
        let lastPlaybackEnd = Date.now();
        let totalAudioMs = 0;
        const pendingTTS: Promise<unknown>[] = [];
        // Serializes clip DISPATCH (not synthesis) so sentences play in order
        // even when a later, shorter sentence synthesizes faster than an earlier
        // one. Each job awaits the previous before queueing its clip + bumping
        // lastPlaybackEnd, keeping playback order and the end estimate correct.
        let ttsTail: Promise<unknown> = Promise.resolve();

        const flipToSpeaking = async () => {
          if (speakingStarted) return;
          speakingStarted = true;
          await setState(sidecarId, 'speaking', '');
        };

        const enqueueSentence = (sentence: string): void => {
          if (!pebbleTTS) return;
          const speakText = stripMarkdownForSpeech(sentence);
          if (!speakText) return; // sentence was pure markdown (e.g. a code fence)
          const prev = ttsTail;
          const job = (async () => {
            const ttsStart = Date.now();
            try {
              const audio = await pebbleTTS!.synthesize(speakText);
              // Synthesis may have finished out of order; wait for the previous
              // sentence's clip to be queued before queueing ours.
              await prev;
              if (ctrl.cancelled) return;
              const clipMs = estimateAudioDurationMs(audio) ?? sentence.length * 60;
              totalAudioMs += clipMs;
              const now = Date.now();
              // Estimate when this clip will finish playing on the sidecar:
              // if the queue is empty (last clip already done) it starts now;
              // otherwise it queues behind the previous clip.
              if (now > lastPlaybackEnd) lastPlaybackEnd = now + clipMs;
              else lastPlaybackEnd += clipMs;

              await sidecarManager.dispatchRPC(sidecarId, 'pebble.play_audio', {
                data: audio.toString('base64'),
                mime_type: ttsMimeType(jarvisConfig.tts),
                blocking: false,
              });
              if (firstAudioDispatchAt === 0) {
                firstAudioDispatchAt = Date.now();
                console.log(
                  `[ambient-ui] first audio dispatched at +${firstAudioDispatchAt - cycleStart}ms ` +
                  `(tts=${Date.now() - ttsStart}ms, sentence="${sentence.slice(0, 60)}${sentence.length > 60 ? '…' : ''}")`,
                );
              }
            } catch (err) {
              console.warn('[ambient-ui] sentence TTS failed:', err);
            }
          })();
          ttsTail = job;
          pendingTTS.push(job);
        };

        let fullText = '';
        const llmStart = Date.now();
        let llmDone = false;
        try {
          // T9 — auto-screenshot for spatial queries. If the user is
          // asking "where is X" / "show me Y" / "how to open Z" and no
          // image is already attached (T19 region capture), grab the
          // current screen so the LLM can pick coordinates from actual
          // pixels instead of guessing from app conventions. Run in
          // parallel with the panel-context build to overlap the latency.
          const wantScreenshot = !opts?.image && NEEDS_SCREENSHOT.test(userText);
          const [panelCtx, autoShot] = await Promise.all([
            buildPanelContext(sidecarId),
            wantScreenshot ? fetchScreenshot(sidecarId) : Promise.resolve(null),
          ]);
          if (autoShot) {
            console.log(
              `[ambient-ui] auto-screenshot attached: ` +
              `${autoShot.sentWidth}x${autoShot.sentHeight} sent, ` +
              `${autoShot.origWidth}x${autoShot.origHeight} actual, ` +
              `scale ${autoShot.scaleX.toFixed(2)}x — ${autoShot.base64.length} base64 chars`,
            );
          }
          // POINT coordinates emitted by the LLM are in the SENT-image
          // coordinate space (the downscaled JPEG). Scale them up to
          // the actual virtual-screen pixels before dispatching to the
          // sidecar so the pebble lands at the real button.
          const pointScaleX = autoShot?.scaleX ?? 1;
          const pointScaleY = autoShot?.scaleY ?? 1;
          const imageInput = opts?.image ?? autoShot;
          // Multi-modal path — image either explicitly supplied (T19
          // region capture) or auto-captured (T9). Else regular text.
          const handle = imageInput
            ? agentService.streamMessageWithImage(
                userText,
                imageInput.base64,
                imageInput.mediaType,
                'pebble',
                panelCtx || undefined,
              )
            : agentService.streamMessage(
                userText,
                'pebble',
                panelCtx || undefined,
              );
          const { stream, onComplete } = handle;
          // T8 — track which [POINT:..] tags we've already dispatched
          // so a tag straddling chunk boundaries isn't double-fired
          // when later chunks complete it. `tagBuffer` holds back any
          // trailing partial `[POINT:` so we never leak tag fragments
          // into the bubble or TTS.
          const dispatchedPoints = new Set<string>();
          let tagBuffer = '';
          // Match a partial [POINT:...] prefix anchored at end of string
          // — used to detect when the buffer ends mid-tag.
          const PARTIAL_POINT_RE = /\[(P(O(I(N(T(:[^\]]*)?)?)?)?)?)?$/;
          // Stagger multiple points so the pebble visibly walks rather
          // than instantly jumps to the last one. 3.5 s hold per point
          // — long enough to see it, short enough not to feel sluggish.
          // Snappier ease (followFactor=0.42 in the sidecar) means most
          // of those 3.5 s are spent at the target, not animating.
          let pointDelayMs = 0;
          // Staggered point_at timers, tracked so a mid-cycle dismissal can
          // cancel the pending hops instead of flying the pebble around after
          // it's already returned to idle.
          const pointTimers: ReturnType<typeof setTimeout>[] = [];
          const onPoint = (rawX: number, rawY: number, label: string) => {
            // Scale image-space coords back to virtual-screen pixels.
            const x = Math.round(rawX * pointScaleX);
            const y = Math.round(rawY * pointScaleY);
            const delay = pointDelayMs;
            pointDelayMs += 4000; // 3.5 s hold + small overlap
            pointTimers.push(setTimeout(() => {
              // User dismissed before this staggered hop fired — don't move
              // the pebble after it's back to idle.
              if (ctrl.cancelled) return;
              sidecarManager.dispatchRPC(sidecarId, 'pebble.point_at', {
                x, y, label, duration_ms: 3500,
              }).catch((err) => {
                console.warn(`[ambient-ui] pebble.point_at(${x},${y}) failed:`, err);
              });
            }, delay));
            const scaledNote = (pointScaleX !== 1 || pointScaleY !== 1)
              ? ` (raw ${rawX},${rawY} × scale ${pointScaleX.toFixed(2)},${pointScaleY.toFixed(2)})`
              : '';
            console.log(`[ambient-ui] point @ (${x},${y}) label="${label}" delay=${delay}ms${scaledNote}`);
          };
          for await (const event of stream) {
            if (ctrl.cancelled) {
              // User dismissed mid-stream. Stop sidecar playback + drain queue.
              for (const t of pointTimers) clearTimeout(t);
              pointTimers.length = 0;
              try {
                await sidecarManager.dispatchRPC(sidecarId, 'pebble.stop_audio', {});
              } catch { /* ignore */ }
              return;
            }
            if (event.type === 'text' && event.text) {
              if (firstTokenAt === 0) firstTokenAt = Date.now();
              // Append to the holdback buffer, strip every closed tag
              // (firing an onPoint for each new one), then split off any
              // trailing partial `[POINT:` so we don't leak it.
              tagBuffer += event.text;
              tagBuffer = stripPointTags(tagBuffer, dispatchedPoints, onPoint);
              const partial = PARTIAL_POINT_RE.exec(tagBuffer);
              let cleanChunk: string;
              if (partial) {
                cleanChunk = tagBuffer.slice(0, partial.index);
                tagBuffer = tagBuffer.slice(partial.index);
              } else {
                cleanChunk = tagBuffer;
                tagBuffer = '';
              }
              visibleText += cleanChunk;
              unsynth += cleanChunk;
              fullText += cleanChunk;

              // Flip to speaking on first token so the bubble starts
              // showing live text immediately. Don't await every chunk's
              // setState — fire-and-forget keeps the stream loop tight.
              if (!speakingStarted) {
                speakingFlipPending = flipToSpeaking();
              }
              void setState(sidecarId, 'speaking', visibleText);

              // Emit any complete sentences for synthesis.
              const { sentences, remainder } = extractCompleteSentences(unsynth);
              for (const s of sentences) enqueueSentence(s);
              unsynth = remainder;
            } else if (event.type === 'tool_call') {
              // T26 — action narration. When the LLM calls a tool that
              // performs a visible action (browser click, desktop click,
              // launching apps, sending mail, etc.), flip the pebble to
              // `working` with a human-readable label of what it's about
              // to do. Read-only / introspection tools (read_file, list_*)
              // are skipped — narrating those would just be noise.
              const tcName = event.tool_call.name;
              const tcArgs = event.tool_call.arguments as Record<string, unknown>;
              if (NARRATE_TOOLS.test(tcName)) {
                const label = describeToolCall(tcName, tcArgs);
                console.log(`[ambient-ui] narrating tool: ${tcName} → "${label}"`);
                void setState(sidecarId, 'working', label);

                // T26b — fly the pebble to the actual click target so
                // the user SEES JARVIS reach for the button before it
                // clicks. Only for tools where we can resolve coords
                // before execution; everything else stays label-only.
                void flyPebbleToToolTarget(sidecarId, tcName, tcArgs, label);
              }
            } else if (event.type === 'done') {
              llmDone = true;
              break;
            } else if (event.type === 'error') {
              console.warn('[ambient-ui] stream error:', event.error);
              if (!fullText) fullText = "I had trouble with that — say it again?";
              llmDone = true;
              break;
            }
          }

          // Drain the tag holdback. If the LLM left a `[POINT:` open at
          // end-of-stream the partial is just text — emit it so we don't
          // silently drop content.
          if (tagBuffer) {
            visibleText += tagBuffer;
            unsynth += tagBuffer;
            fullText += tagBuffer;
            tagBuffer = '';
          }
          // Flush any tail fragment as the last sentence.
          const tail = unsynth.trim();
          if (tail) enqueueSentence(tail);
          unsynth = '';

          // Fire-and-forget extraction + learning.
          void onComplete(fullText);
        } catch (err) {
          console.warn('[ambient-ui] stream cycle error:', err);
          if (!fullText) fullText = "I had trouble with that — say it again?";
        }
        const llmMs = Date.now() - llmStart;
        if (ctrl.cancelled) return;
        if (speakingFlipPending) await speakingFlipPending;
        // Make sure the bubble shows the final text (in case the last
        // setState lost a race).
        await setState(sidecarId, 'speaking', fullText);
        try { wsService.broadcastHeartbeat(fullText); } catch { /* dashboard may not be open */ }

        // Long-answer overflow — if the response is too long to comfortably
        // fit in the speaking bubble, register it in the answer store and
        // ask the sidecar to paint an "open full ↗" button. Threshold matches
        // roughly what the 200 px bubble cap can hold without ellipsizing.
        const OVERFLOW_CHARS = 600;
        if (fullText.length > OVERFLOW_CHARS) {
          try {
            const { pebbleAnswerStore } = await import('./answer-store.ts');
            const record = pebbleAnswerStore.register(userText, fullText);
            await sidecarManager.dispatchRPC(sidecarId, 'pebble.set_answer_overflow', {
              answer_id: record.id,
            }).catch(() => { /* sidecar may not have pebble cap */ });
            console.log(`[pebble] long answer registered (${fullText.length} chars) → ${record.id}`);
          } catch (err) {
            console.warn('[pebble] failed to register long answer:', err);
          }
        }

        // Wait for all pending TTS synths to settle so totalAudioMs is final.
        await Promise.allSettled(pendingTTS);

        const firstTokenMs = firstTokenAt > 0 ? firstTokenAt - llmStart : 0;
        const firstAudioMs = firstAudioDispatchAt > 0 ? firstAudioDispatchAt - llmStart : 0;
        console.log(
          `[ambient-ui] JARVIS (${llmMs}ms LLM, ${firstTokenMs}ms to first token, ${firstAudioMs}ms to first audio) → ` +
          `"${fullText.slice(0, 200)}${fullText.length > 200 ? '…' : ''}"`,
        );
        console.log(
          `[ambient-ui] timings: llm=${llmMs}ms total_audio≈${totalAudioMs}ms ` +
          `total_pre_first_audio=${firstAudioMs || llmMs}ms`,
        );

        // Hold speaking state until the last queued clip finishes. The
        // sidecar's queue worker plays clips back-to-back; lastPlaybackEnd
        // tracks our best estimate of when the last clip's audio ends.
        //
        // When TTS is off (totalAudioMs === 0), the bubble would otherwise
        // close immediately — too fast to read the answer. Hold it open for
        // a text-length-derived reading window so no-TTS users get time
        // to actually read what JARVIS said. User can dismiss anytime by
        // pressing the summon hotkey (Ctrl+Space).
        let readingHoldMs = 0;
        if (totalAudioMs === 0 && fullText.length > 0) {
          // ~60 ms/char gives skim time; clamp 6–30 s so short answers
          // don't linger and very long ones don't trap the rail forever.
          readingHoldMs = Math.min(30_000, Math.max(6_000, fullText.length * 60));
          console.log(`[ambient-ui] no TTS — holding bubble ${readingHoldMs}ms for reading`);
        }
        const remainingMs = Math.max(
          readingHoldMs,
          lastPlaybackEnd - Date.now(),
        );
        if (remainingMs > 0) {
          // Sleep in 100 ms slices so dismissal (ctrl.cancelled) cuts
          // through the hold without waiting the full timeout.
          const sliceMs = 100;
          for (let waited = 0; waited < remainingMs; waited += sliceMs) {
            if (ctrl.cancelled) return;
            await new Promise<void>(r => setTimeout(r, sliceMs));
          }
        }
        if (ctrl.cancelled) return;

        await setState(sidecarId, 'idle', '');
        // Suppress unused-var warning if linting cared.
        void llmDone;
      };

      audioSessions.onComplete(async (session) => {
        const ctrl = pendingSummons.get(session.sidecarId);
        // A session arrived: the listening phase is over, so cancel the bare-wake
        // fallback timer before it can interrupt the response cycle that follows.
        clearListenTimer(session.sidecarId);
        if (!ctrl || ctrl.cancelled) return; // user dismissed mid-capture

        console.log(
          `[ambient-ui] session ${session.sessionId} captured: ` +
          `${session.pcm.length} PCM bytes, ${session.durationMs}ms`
        );

        try {
          await setState(session.sidecarId, 'thinking', '');

          let transcript = '';
          if (pebbleSTT) {
            const wav = pcmToWav(session.pcm, session.sampleRate, session.channels);
            const sttStart = Date.now();
            try {
              transcript = (await pebbleSTT.transcribe(wav)).trim();
              console.log(`[ambient-ui] STT (${Date.now() - sttStart}ms, ${transcript.length} chars)`);
            } catch (err) {
              console.warn('[ambient-ui] STT error:', err);
            }
          } else {
            console.warn('[ambient-ui] no STT configured — pebble can capture but not understand');
          }
          if (ctrl.cancelled) return;

          if (!transcript) {
            console.log('[ambient-ui] empty transcript — returning to idle');
            await setState(session.sidecarId, 'idle', '');
            clearSummon(session.sidecarId, ctrl);
            return;
          }
          console.log(`[ambient-ui] user said (${transcript.length} chars)`);

          await runResponseCycle(session.sidecarId, transcript, ctrl);
          clearSummon(session.sidecarId, ctrl);
        } catch (err) {
          console.warn('[ambient-ui] voice cycle error:', err);
          await setState(session.sidecarId, 'idle', '');
          clearSummon(session.sidecarId, ctrl);
        }
      });

      // T16 — sidecar wake-word path. The sidecar's WakeListenerService
      // emits one `audio.wake_segment` per VAD-detected utterance. We
      // transcribe and word-search for "jarvis"; on a hit, we either
      //   - run the LLM directly with the trailing command (single-shot,
      //     "Jarvis play music" works without saying it twice), or
      //   - if only "jarvis" alone, fire a normal listening summon so the
      //     user can speak the command after the bubble pops up.
      // Suppressed when a summon cycle is already running so the
      // continuous wake stream doesn't fight with the active turn.
      const wakePhrase = /\bjarvis\b/i;
      const stripWakePrefix = (text: string): string => {
        // Pull out the segment after the LAST occurrence of "jarvis" so
        // "I'm at home, Jarvis play music" → "play music". Trailing
        // punctuation/whitespace removed; if nothing follows, returns "".
        const re = /\bjarvis\b[\s,.\-—:]*/gi;
        let last: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          last = m;
        }
        if (!last) return '';
        return text.slice(last.index + last[0].length).trim();
      };

      sidecarManager.onEvent(async (sidecarId, event) => {
        if (event.event_type !== 'audio.wake_segment') return;
        // Suppress while an active summon is in flight — the user already
        // got JARVIS's attention via Ctrl+Space (or a prior wake).
        if (pendingSummons.has(sidecarId)) return;
        if (!pebbleSTT) return;
        // Claim a synchronous in-flight flag before the first await so a
        // concurrent wake segment can't start a second response cycle.
        if (wakeInFlight.has(sidecarId)) return;
        wakeInFlight.add(sidecarId);
        try {

        const payload = (event.payload as Record<string, unknown> | undefined) ?? {};
        const binary = (event.binary as { type?: string; data?: string } | undefined);
        if (!binary || binary.type !== 'inline' || typeof binary.data !== 'string') return;

        let pcm: Buffer;
        try {
          pcm = Buffer.from(binary.data, 'base64');
        } catch {
          return;
        }
        const sampleRate = Number(payload.sample_rate ?? 16000);
        const channels = Number(payload.channels ?? 1);

        let transcript = '';
        const sttStart = Date.now();
        try {
          const wav = pcmToWav(pcm, sampleRate, channels);
          transcript = (await pebbleSTT.transcribe(wav)).trim();
        } catch (err) {
          console.warn('[ambient-ui] wake-segment STT error:', err);
          return;
        }
        const sttMs = Date.now() - sttStart;
        if (!transcript) return;
        if (!wakePhrase.test(transcript)) {
          // Most segments — user talking about other things. Quietly drop.
          return;
        }
        console.log(`[ambient-ui] wake-segment matched (${sttMs}ms STT, ${transcript.length} chars)`);

        const command = stripWakePrefix(transcript);
        // Re-check: a manual summon (Ctrl+Space) may have claimed the slot while
        // we were transcribing (the entry guard at the top ran before the STT
        // await). The deliberate press wins, so bail rather than clobber its ctrl
        // and resolve its session_end against ours.
        if (pendingSummons.has(sidecarId)) return;
        // Claim the summon slot so the rest of this cycle owns it.
        const ctrl = { cancelled: false };
        pendingSummons.set(sidecarId, ctrl);

        if (!command) {
          // Just "Jarvis" alone — flip to listening and trigger a fresh
          // session capture on the sidecar so the user's next utterance
          // gets transcribed + run through the LLM. The session_end
          // event will land in `audioSessions.onComplete` above, which
          // sees the pendingSummons we just set and runs the response
          // cycle. The session capture's own VAD hard-cap normally bounds the
          // wait, but a dropped session_end would otherwise wedge us in
          // `listening` forever, so arm a fallback (cleared in onComplete the
          // instant a session is actually consumed, so it never cuts a response).
          await setState(sidecarId, 'listening', '');
          try {
            const res = (await sidecarManager.dispatchRPC(sidecarId, 'pebble.start_listening', {})) as
              | { started?: boolean; reason?: string }
              | undefined;
            if (res?.started === false) {
              // The sidecar refused to open the mic — the user muted it between
              // the wake segment being captured and this call landing. Give the
              // slot back now instead of holding `listening` until the fallback
              // timer fires, and leave the pebble showing why.
              console.log(`[ambient-ui] wake → start_listening refused (${res.reason ?? 'unknown'})`);
              ctrl.cancelled = true;
              clearSummon(sidecarId, ctrl);
              // No text argument for the muted case: the sidecar has already
              // put the reason in the bubble, and passing text here would
              // overwrite it with the default per-state copy.
              if (res.reason === 'muted') await setState(sidecarId, 'muted');
              else await setState(sidecarId, 'idle', '');
              return;
            }
            console.log(`[ambient-ui] wake → listening (capture started)`);
            clearListenTimer(sidecarId);
            pendingListenTimers.set(sidecarId, setTimeout(() => {
              pendingListenTimers.delete(sidecarId);
              if (pendingSummons.get(sidecarId) !== ctrl) return; // already consumed/replaced
              console.warn('[ambient-ui] wake → listening: no session_end within fallback window — resetting to idle');
              ctrl.cancelled = true;
              clearSummon(sidecarId, ctrl);
              void setState(sidecarId, 'idle', '');
            }, WAKE_LISTEN_FALLBACK_MS));
          } catch (err) {
            console.warn('[ambient-ui] wake → start_listening failed:', err);
            ctrl.cancelled = true;
            clearSummon(sidecarId, ctrl);
            await setState(sidecarId, 'idle', '');
          }
          return;
        }

        try {
          console.log(`[ambient-ui] wake → command: "${command}"`);
          await runResponseCycle(sidecarId, command, ctrl);
        } catch (err) {
          console.warn('[ambient-ui] wake voice cycle error:', err);
          await setState(sidecarId, 'idle', '');
        } finally {
          clearSummon(sidecarId, ctrl);
        }

        } finally {
          wakeInFlight.delete(sidecarId);
        }
      });

      // The sidecar turned a mic request away because the user has the mic muted
      // from the tray. Mute is sidecar-owned local state, so mostly this is
      // informational — the two paths that could open a cycle already handle
      // their own refusal (`pebble.summon` carries a `muted` flag, and
      // `pebble.start_listening` answers `started: false`).
      //
      // What's left is the narrow race: mute landing AFTER a press was reported
      // unmuted, or mid-capture, which leaves a summon slot with no audio ever
      // coming. Unwind it — but only when the session id matches the slot's, so
      // an unrelated in-flight turn can't be interrupted by a stray event (the
      // hazard the stray-region.captured comment below spells out).
      sidecarManager.onEvent((sidecarId, event) => {
        if (event.event_type !== 'pebble.mic_blocked') return;
        const payload = (event.payload as { reason?: string; source?: string; session_id?: string } | undefined) ?? {};
        console.log(
          `[ambient-ui] mic blocked on ${sidecarId} ` +
          `(source=${payload.source ?? '?'}, reason=${payload.reason ?? '?'})`,
        );
        const ctrl = pendingSummons.get(sidecarId);
        if (!ctrl || !payload.session_id || ctrl.sessionId !== payload.session_id) return;
        ctrl.cancelled = true;
        clearListenTimer(sidecarId);
        clearSummon(sidecarId, ctrl);
        void setState(sidecarId, 'muted'); // no text — the sidecar's bubble already says why
      });

      // T19 — region.captured / region.cancelled. The user said "help
      // with this", we kicked off the overlay; now the screenshot is
      // here (or they cancelled). Run a multi-modal LLM cycle with the
      // image attached.
      sidecarManager.onEvent(async (sidecarId, event) => {
        if (event.event_type === 'region.cancelled') {
          const pending = pendingRegionByPebble.get(sidecarId);
          pendingRegionByPebble.delete(sidecarId);
          if (pending) {
            pending.ctrl.cancelled = true;
            await setState(sidecarId, 'idle', '');
            clearSummon(sidecarId, pending.ctrl);
          }
          return;
        }
        if (event.event_type !== 'region.captured') return;
        const pending = pendingRegionByPebble.get(sidecarId);
        // No pending region for this capture. The region flow already concluded
        // (a prior captured/cancelled cleaned up, or the sidecar reconnected),
        // so this is a stray/duplicate event. Deliberately a no-op: we must NOT
        // reset state or clear pendingSummons here, because at this point the
        // summon slot is either already cleared or owned by an unrelated
        // in-flight turn — clearing it would interrupt that turn. The genuine
        // "stuck in working" cases are handled by keeping pendingRegion alive
        // for the whole cycle (below) and by the disconnect cleanup handler.
        if (!pending) return;
        // A response cycle is already running for this region. Because onEvent
        // listeners aren't awaited serially, a duplicate `region.captured` can
        // land mid-cycle; ignore it rather than tearing down the live cycle.
        if (regionCycleActive.has(sidecarId)) return;

        const binary = event.binary as { type?: string; data?: string; mime_type?: string } | undefined;
        if (!binary || binary.type !== 'inline' || typeof binary.data !== 'string') {
          pendingRegionByPebble.delete(sidecarId);
          clearSummon(sidecarId, pending.ctrl);
          await setState(sidecarId, 'idle', '');
          return;
        }
        const imageBase64 = binary.data;
        const mimeType = binary.mime_type || 'image/png';
        const { ctrl, userText } = pending;
        const payload = (event.payload as Record<string, unknown> | undefined) ?? {};
        console.log(
          `[ambient-ui] region.captured: ${imageBase64.length} base64 chars, ` +
          `${payload.width}x${payload.height}, mime=${mimeType}, prompt="${userText}"`,
        );
        if (ctrl.cancelled) {
          pendingRegionByPebble.delete(sidecarId);
          clearSummon(sidecarId, ctrl);
          return;
        }

        // Frame the question for the LLM: include the original voice
        // text plus a hint that the image is the user's pointer.
        const promptText = `${userText}\n\n(I've attached a screenshot of the area I selected on screen. Look at the image and answer based on what's shown there.)`;
        // Mark the cycle active and keep the pendingRegion entry until the
        // finally — together these make a concurrent duplicate capture a no-op
        // and guarantee state is torn down on every exit (success, error, or
        // image-validation failure above).
        regionCycleActive.add(sidecarId);
        try {
          await runResponseCycle(sidecarId, promptText, ctrl, {
            image: { base64: imageBase64, mediaType: mimeType },
          });
        } catch (err) {
          console.warn('[ambient-ui] region voice cycle error:', err);
          await setState(sidecarId, 'idle', '');
        } finally {
          regionCycleActive.delete(sidecarId);
          pendingRegionByPebble.delete(sidecarId);
          clearSummon(sidecarId, ctrl);
        }
      });

      console.log('[ambient-ui] Enabled — native pebble overlay (GDI+/Cocoa/Cairo) will spawn on sidecars with the \'pebble\' capability');
    }

    // 7. Register services in startup order
    //    Agent first (needs DB), Observers second, Channels third, Sidecar, WebSocket last (needs Agent)
    registry.register(telemetryService);
    registry.register(agentService);
    if (observerService) registry.register(observerService);
    registry.register(channelService);
    registry.register(sidecarManager);
    registry.register(wsService);

    // 8. Start health monitor (before services, so API routes can reference it)
    healthMonitor = new HealthMonitor(registry, config.dbPath);

    // 8b. Wire channel service to WebSocket for cross-channel broadcasts
    wsService.setChannelService(channelService);

    // 8c. Wire TTS provider if configured
    if (jarvisConfig.tts?.enabled) {
      const { createTTSProvider } = await import('../comms/voice.ts');
      const { effectiveTtsForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
      const ttsBinding = effectiveTtsForBinding(jarvisConfig);
      const ttsProvider = ttsBinding
        ? createTTSProvider(ttsBinding, usejarvisVoiceCredentials(jarvisConfig))
        : null;
      if (ttsProvider) {
        wsService.setTTSProvider(ttsProvider);
        console.log(`[Daemon] TTS enabled: ${ttsBinding?.provider ?? 'edge'} (${jarvisConfig.tts.voice ?? 'en-US-AriaNeural'})`);
      }
    }

    // 8d. Wire STT provider for voice input via dashboard. Guard on the
    // BINDING result, not on config.stt existing (like channel-service):
    // the hosted default applies even when the section is absent.
    {
      const { createSTTProvider } = await import('../comms/voice.ts');
      const { effectiveSttForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
      const sttBinding = effectiveSttForBinding(jarvisConfig);
      const sttProvider = sttBinding
        ? createSTTProvider(sttBinding, usejarvisVoiceCredentials(jarvisConfig))
        : null;
      if (sttProvider) {
        wsService.setSTTProvider(sttProvider);
        console.log(`[Daemon] STT for voice input: ${sttBinding!.provider}`);
      }
    }

    // 8e. Wire Authority & Autonomy Engine
    const authorityConfig = jarvisConfig.authority ?? { default_level: 3 };
    const authorityEngine = new AuthorityEngine({
      default_level: authorityConfig.default_level,
      governed_categories: (authorityConfig.governed_categories ?? ['send_email', 'send_message', 'make_payment']) as any,
      overrides: (authorityConfig.overrides ?? []) as any,
      context_rules: (authorityConfig.context_rules ?? []) as any,
      learning: authorityConfig.learning ?? { enabled: true, suggest_threshold: 5 },
      emergency_state: authorityConfig.emergency_state ?? 'normal',
    });
    const approvalManager = new ApprovalManager();
    const auditTrail = new AuditTrail();
    const learner = new AuthorityLearner(authorityConfig.learning?.suggest_threshold ?? 5);
    const emergencyController = new EmergencyController();
    const approvalDelivery = new ApprovalDelivery();
    const deferredExecutor = new DeferredExecutor(approvalManager, auditTrail);
    deferredExecutor.setLearner(learner);
    // Approved actions must respect the kill switch too, not just the gate.
    deferredExecutor.setEmergencyController(emergencyController);
    // Inline requests are owned by an authority gate blocked in-process;
    // any that survived a restart have no gate anymore, so hand them to
    // the deferred path or approving them would execute nothing.
    const orphanedInline = approvalManager.demoteAllPendingInline();
    if (orphanedInline > 0) {
      console.log(`[Daemon] Demoted ${orphanedInline} orphaned inline approval(s) to deferred`);
    }
    // Phase 6.3.5b — let WS service resolve approvals from voice intents.
    wsService.setApprovalManager(approvalManager);
    wsService.setDeferredExecutor(deferredExecutor);
    // Voice-channel audit tagging for forensic separation from click path.
    wsService.setAuditTrail(auditTrail);

    // Restore emergency state from config
    const savedEmergencyState = authorityConfig.emergency_state ?? 'normal';
    if (savedEmergencyState === 'paused') emergencyController.pause();
    else if (savedEmergencyState === 'killed') emergencyController.kill();

    // Persist emergency state changes to the DB settings store
    emergencyController.setStateChangeCallback(async (state) => {
      wsService.broadcastEmergencyState(state);
      try {
        const { saveUserSection } = await import('./user-settings.ts');
        if (!jarvisConfig.authority) jarvisConfig.authority = { default_level: 3 } as any;
        jarvisConfig.authority.emergency_state = state;
        saveUserSection('authority', jarvisConfig.authority);
      } catch (err) {
        console.error('[Daemon] Failed to persist emergency state:', err);
      }
    });

    // 8f. Settings hot reload: per-section appliers. Everything they need
    // (wsService, channelService, registry, observers, authority) is in
    // scope here. Appliers are idempotent — routes that already apply a
    // change by hand (LLM, TTS) can keep doing so; a second run is harmless.
    settingsReload.setBroadcast((p) => wsService.broadcastSettingsApplied(p));

    // channels — Telegram/Discord adapters bake tokens (and the STT
    // provider) into their constructors, so restart-in-place is the apply.
    // Debounced so back-to-back saves reconnect the bots once.
    settingsReload.registerApplier('channels', async () => {
      await registry!.stopService('channels');
      await registry!.startService('channels');
    }, { debounceMs: 400 });

    // stt — swap the dashboard voice-input provider; live channel adapters
    // captured the old provider at construction, so chain a channels
    // restart when any channel is connected.
    settingsReload.registerApplier('stt', async (cfg) => {
      const { createSTTProvider } = await import('../comms/voice.ts');
      const { effectiveSttForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
      const sttBinding = effectiveSttForBinding(cfg);
      wsService.setSTTProvider(sttBinding ? createSTTProvider(sttBinding, usejarvisVoiceCredentials(cfg)) : null);
      if (Object.values(channelService.getChannelStatus()).some(Boolean)) {
        settingsReload!.sectionChanged('channels');
      }
    });

    // tts — same swap the /api/config/tts route already does by hand; this
    // also covers voice-command toggles and reloadAll, and clears the
    // provider on disable.
    settingsReload.registerApplier('tts', async (cfg) => {
      const { createTTSProvider } = await import('../comms/voice.ts');
      const { effectiveTtsForBinding, usejarvisVoiceCredentials } = await import('./usejarvis-ai.ts');
      const ttsBinding = cfg.tts?.enabled ? effectiveTtsForBinding(cfg) : undefined;
      wsService.setTTSProvider(ttsBinding ? createTTSProvider(ttsBinding, usejarvisVoiceCredentials(cfg)) : null);
    });

    // google — refresh the auth (disconnect unlinks the tokens file; the
    // null-first reload drops the stale in-memory tokens), hand it to the
    // observers and restart them so EmailSync/CalendarSync re-capture it.
    let lastGoogleCreds = googleIdentity(jarvisConfig);
    settingsReload.registerApplier('google', async (cfg) => {
      const creds = googleIdentity(cfg);
      if (!creds) {
        googleAuth = null;
      } else if (googleAuth && creds === lastGoogleCreds) {
        googleAuth.reloadTokensFromDisk();
      } else {
        googleAuth = makeGoogleAuth(cfg);
      }
      lastGoogleCreds = creds;
      if (observerService) {
        observerService.setGoogleAuth(googleAuth);
        // Re-read alongside the auth so the watches are armed from the live
        // config rather than whatever booted. (The notify secret and channel
        // token are keyed by the INSTANCE id, which a migration preserves, so
        // those two do not actually change on a move — the topic and callback
        // can, if the deployment's config did.)
        observerService.setPushTargets({
          pubsubTopic: cfg.google?.pubsub_topic,
          pushCallback: cfg.google?.push_callback,
          channelToken: cfg.google?.channel_token,
        });
        await registry!.stopService('observers');
        await registry!.startService('observers');
      }
    });

    // llm — routes keep their synchronous hotReloadLLMProviders call for an
    // accurate response; this covers reloadAll/SIGHUP (external DB edits).
    settingsReload.registerApplier('llm', async (cfg) => {
      const { hotReloadLLMProviders } = await import('./llm-settings.ts');
      hotReloadLLMProviders(cfg, agentService.getLLMManager());
    });

    // authority — keep the engine's construction-time snapshot in sync on a
    // full reload (mirror of the POST /api/authority/config mapping).
    // emergency_state is excluded: EmergencyController owns it.
    settingsReload.registerApplier('authority', async (cfg) => {
      const a = cfg.authority;
      if (!a) return;
      const current = authorityEngine.getConfig();
      authorityEngine.updateConfig({
        ...current,
        default_level: a.default_level ?? current.default_level,
        governed_categories: (a.governed_categories ?? current.governed_categories) as any,
        overrides: (a.overrides ?? current.overrides) as any,
        context_rules: (a.context_rules ?? current.context_rules) as any,
        learning: a.learning ?? current.learning,
      });
    });

    // awareness — the service snapshots its sub-config at construction; the
    // enabled flag is the one knob with a live setter today.
    settingsReload.registerApplier('awareness', async (cfg) => {
      awarenessService?.toggle(cfg.awareness?.enabled !== false);
    });
    // voice needs no applier: resolveRealtimeVoice reads live config per call.

    // ── Tray menu live data (design: usejarvis-tray §00) ──
    // Push a status snapshot to each connected sidecar every few seconds so the
    // tray menu (read on open) shows pending approvals, pause state, health, and
    // the recent-activity block. The pebble state is pushed separately by the
    // ambient-ui loop, deduped.
    const trayRelTime = (ts: number): string => {
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h`;
      return `${Math.floor(h / 24)}d`;
    };
    // Humanize a tool_name ("send_email") into a short activity label ("Send email").
    const trayHumanizeTool = (tool: string): string => {
      const words = tool.replace(/[_-]+/g, ' ').trim();
      return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Action';
    };
    // Recent activity = the last few actions Jarvis actually carried out, newest
    // first. Sourced from approvals that were approved/executed (the actions the
    // user cares about); auto-approved low-risk actions aren't gated so don't
    // appear here. Best-effort — never let it break the heartbeat.
    const buildTrayRecent = (): string[] => {
      try {
        return approvalManager
          .getHistory({ limit: 8 })
          .filter((r) => r.status === 'executed' || r.status === 'approved')
          .slice(0, 3)
          .map((r) => `${trayHumanizeTool(r.tool_name)} · ${trayRelTime(r.executed_at ?? r.decided_at ?? r.created_at)}`);
      } catch {
        return [];
      }
    };
    const trayStatusTimer = setInterval(() => {
      try {
        const connected = sidecarManager.getConnectedSidecars();
        if (connected.length === 0) return;
        const enrolled = sidecarManager.listSidecars().length || connected.length;
        const payload = {
          waiting: approvalManager.getPending().length,
          paused: emergencyController.getState() === 'paused',
          brain_online: true,
          port: config.port,
          sidecars: `${connected.length}/${enrolled}`,
          recent: buildTrayRecent(),
        };
        for (const sc of connected) {
          void sidecarManager.dispatchRPC(sc.id, 'tray.status', payload).catch(() => {});
        }
      } catch {
        /* best-effort heartbeat */
      }
    }, 4000);
    trayStatusTimer.unref?.(); // the heartbeat must not keep the process alive

    // Tray → brain: the "Pause Jarvis" toggle drives the emergency controller.
    // ("Mute microphone" is mic control the sidecar owns locally, not here.)
    sidecarManager.onEvent((_sidecarId, event) => {
      if (event.event_type !== 'tray.set_pause') return;
      const paused = (event.payload as { paused?: boolean } | undefined)?.paused === true;
      if (paused) emergencyController.pause();
      else emergencyController.resume();
    });

    // ── Outbound OS notifications (design: usejarvis-tray §01) ──
    // The four reasons Jarvis interrupts: it needs your OK (approval), it
    // finished (done), a machine dropped (sidecar), or an update is ready
    // (update). Each is raised natively by the sidecar via notify.show; the
    // user's choice returns as a notify.action event. Book 08 originally held
    // Approve/Deny to ordinary actions and gave irreversible ones "Review in
    // Jarvis" only; the founder opted to allow Approve/Deny on every approval
    // notification (the impact still shows in the body's meta as a risk cue).
    // All four reasons are wired: approval, done (an approved action finished),
    // sidecar-offline, and update (a connecting sidecar below the recommended
    // version — the compat verdict already on the ConnectedSidecar).
    const notifyAll = (payload: Record<string, unknown>): void => {
      for (const sc of sidecarManager.getConnectedSidecars()) {
        void sidecarManager.dispatchRPC(sc.id, 'notify.show', payload).catch(() => {});
      }
    };

    // New pending approvals → one notification each, deduped and recent-only so a
    // sidecar reconnect doesn't blast the whole backlog. The same poll also
    // catches approvals that just finished executing → the "done" notification.
    const notifiedApprovalIds = new Set<string>();
    const notifiedDoneIds = new Set<string>();
    const approvalNotifyTimer = setInterval(() => {
      try {
        if (sidecarManager.getConnectedSidecars().length === 0) return;
        for (const req of approvalManager.getPending()) {
          if (notifiedApprovalIds.has(req.id)) continue;
          notifiedApprovalIds.add(req.id);
          if (Date.now() - req.created_at > 60_000) continue; // skip the backlog
          // Product call (founder): Approve/Deny on every approval notification,
          // including irreversible ones — the review-only candor exception is
          // dropped. The impact still rides along in `meta` ("destructive ·
          // delete_data") so the toast reads the risk even when it's approvable.
          const impact = impactFromCategory(req.action_category);
          notifyAll({
            id: req.id,
            kind: 'approval',
            title: `Approve: ${trayHumanizeTool(req.tool_name)}?`,
            body: req.reason?.trim() || `${req.agent_name} wants to run ${trayHumanizeTool(req.tool_name)}.`,
            meta: `${impact} · ${req.tool_name}`,
            destructive: impact === 'destructive',
            actions: [
              { id: 'deny', label: 'Deny' },
              { id: 'approve', label: 'Approve', primary: true },
            ],
          });
        }
        if (notifiedApprovalIds.size > 200) {
          const pending = new Set(approvalManager.getPending().map((r) => r.id));
          for (const id of notifiedApprovalIds) if (!pending.has(id)) notifiedApprovalIds.delete(id);
        }

        // Approved actions that finished → the "Task complete" (done) notification
        // — the design's own example (the send_email you approved, sent). Scoped
        // to executed approvals for now: a bounded, non-naggy source (you approved
        // them); broader task-done hooks can feed the same path later. Ordered by
        // creation, but approvals execute shortly after creation, so the recent
        // window catches them.
        const executed = approvalManager.getHistory({ status: 'executed', limit: 12 });
        for (const req of executed) {
          if (notifiedDoneIds.has(req.id)) continue;
          notifiedDoneIds.add(req.id);
          const doneAt = req.executed_at ?? req.decided_at ?? req.created_at;
          if (Date.now() - doneAt > 60_000) continue; // skip the backlog
          notifyAll({
            id: `done:${req.id}`,
            kind: 'done',
            title: 'Task complete',
            body: req.reason?.trim() || `${trayHumanizeTool(req.tool_name)} finished.`,
            actions: [
              { id: 'view', label: 'View', primary: true },
              { id: 'dismiss', label: 'Dismiss' },
            ],
          });
        }
        if (notifiedDoneIds.size > 200) {
          const recent = new Set(executed.map((r) => r.id));
          for (const id of notifiedDoneIds) if (!recent.has(id)) notifiedDoneIds.delete(id);
        }
      } catch {
        /* best-effort */
      }
    }, 3000);
    approvalNotifyTimer.unref?.();

    // A machine dropped → tell the other connected sidecars. Keep a name map so
    // the body can say which machine (the sidecar object is gone by disconnect).
    // On connect we also fire the "update" notification when the sidecar's
    // version verdict is 'suggested' (below SIDECAR_RECOMMENDED_VERSION) — the
    // honest, already-computed signal for the fourth reason. Sent only to that
    // machine, deduped per (id, version) so a reconnect flap can't nag.
    const sidecarNameById = new Map<string, string>();
    const notifiedUpdateKeys = new Set<string>();
    sidecarManager.onSidecarConnected((sc) => {
      sidecarNameById.set(sc.id, sc.name);
      if (sc.updateStatus === 'suggested') {
        const key = `${sc.id}:${sc.version}`;
        if (!notifiedUpdateKeys.has(key)) {
          notifiedUpdateKeys.add(key);
          void sidecarManager.dispatchRPC(sc.id, 'notify.show', {
            id: `update:${sc.id}`,
            kind: 'update',
            title: 'Update Jarvis',
            body: `This machine is on ${sc.version}; ${SIDECAR_RECOMMENDED_VERSION} is recommended.`,
            destructive: false,
            actions: [
              { id: 'review', label: 'Open Jarvis', primary: true },
              { id: 'later', label: 'Later' },
            ],
          }).catch(() => {});
        }
      }
    });
    // Offline toasts ride a grace timer (a quick reconnect cancels it) plus a
    // per-machine cooldown, so a flapping connection can't nag every flap.
    const offlineNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const offlineNotifiedAt = new Map<string, number>();
    const OFFLINE_NOTIFY_GRACE_MS = 15_000;
    const OFFLINE_NOTIFY_COOLDOWN_MS = 5 * 60_000;
    sidecarManager.onSidecarConnected((sc) => {
      const t = offlineNotifyTimers.get(sc.id);
      if (t) {
        clearTimeout(t);
        offlineNotifyTimers.delete(sc.id);
      }
    });
    sidecarManager.onSidecarDisconnected((id) => {
      const name = sidecarNameById.get(id) ?? 'A machine';
      sidecarNameById.delete(id);
      if (offlineNotifyTimers.has(id)) return;
      const last = offlineNotifiedAt.get(id) ?? 0;
      if (Date.now() - last < OFFLINE_NOTIFY_COOLDOWN_MS) return;
      const timer = setTimeout(() => {
        offlineNotifyTimers.delete(id);
        offlineNotifiedAt.set(id, Date.now());
        notifyAll({
          id: `sidecar:${id}`,
          kind: 'sidecar',
          title: 'Sidecar disconnected',
          body: `${name} went offline. The agent can’t act on that machine until it’s back.`,
          destructive: false,
          actions: [
            { id: 'review', label: 'Open Jarvis', primary: true },
            { id: 'dismiss', label: 'Dismiss' },
          ],
        });
      }, OFFLINE_NOTIFY_GRACE_MS);
      timer.unref?.();
      offlineNotifyTimers.set(id, timer);
    });

    // The user's choice from a notification. Only the approval buttons act on the
    // brain (Approve/Deny, mirroring the dashboard endpoint); 'review'/'dismiss'
    // are handled sidecar-side (it opened the app) so there's nothing to do here.
    sidecarManager.onEvent((_sidecarId, event) => {
      if (event.event_type !== 'notify.action') return;
      const p = (event.payload ?? {}) as { id?: string; kind?: string; action?: string };
      if (p.kind === 'approval' && p.id && (p.action === 'approve' || p.action === 'deny')) {
        const { id, action } = p;
        void applyApprovalDecision(action, id, 'notification', { approvalManager, deferredExecutor, wsService })
          .catch((err) => console.error('[Daemon] notification approval decision failed:', err));
      }
    });

    // Wire authority engine into orchestrator
    const orchestrator = agentService.getOrchestrator();
    orchestrator.setAuthorityEngine(authorityEngine);
    orchestrator.setApprovalManager(approvalManager);
    // Inline approval execution: the authority gate blocks on the user's
    // decision and executes the approved tool itself, so results flow back
    // through the task envelope to the conversation tier.
    orchestrator.setDeferredExecutor(deferredExecutor);
    orchestrator.setAuditTrail(auditTrail);
    orchestrator.setEmergencyController(emergencyController);

    // Wire approval callback: when orchestrator needs approval, deliver to user
    orchestrator.setApprovalCallback((request) => {
      approvalDelivery.deliver(request).catch(err =>
        console.error('[Daemon] Approval delivery error:', err)
      );
    });

    // Wire authority engine into agent-service for prompt context
    agentService.setAuthorityEngine(authorityEngine);

    // Wire deferred executor tool registry (after start, tools are registered)
    // Note: toolRegistry set after startAll() below

    // Wire channel approval handler
    channelService.setApprovalHandler(async (action, shortId, channel) => {
      const request = approvalManager.findByShortId(shortId);
      if (!request) return `No pending approval found for ID ${shortId}`;

      const outcome = await applyApprovalDecision(action, request.id, channel, { approvalManager, deferredExecutor, wsService });
      if (outcome.status === 'already_decided') return 'Request already decided';
      if (outcome.status === 'denied') return `Denied: ${request.tool_name}`;
      if (outcome.executed) return `Approved and executed. Result: ${outcome.result.slice(0, 200)}`;
      if (outcome.error) return `Approved, but execution failed: ${outcome.error.slice(0, 200)}`;
      return 'Approved. The agent will continue and report back in chat.';
    });

    console.log(`[Daemon] Authority engine initialized (governed: ${authorityEngine.getConfig().governed_categories.join(', ')})`);

    // 9. Ensure UI is built (auto-build if ui/dist is missing or empty)
    const uiDistDir = path.join(import.meta.dir, '../../ui/dist');
    const uiIndexPath = path.join(uiDistDir, 'index.html');
    if (!existsSync(uiIndexPath)) {
      logWithTimestamp('Dashboard UI not built — building automatically...');
      const buildResult = Bun.spawnSync(['bun', 'run', 'build:ui'], {
        cwd: path.join(import.meta.dir, '../..'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });
      if (buildResult.exitCode === 0) {
        logWithTimestamp('Dashboard UI built successfully');
      } else {
        const stderr = buildResult.stderr.toString().trim();
        console.warn(`[Daemon] UI build failed (dashboard may not load): ${stderr.slice(0, 200)}`);
      }
    }

    // 9b. Set up API routes + dashboard static files
    const apiContext: import('./api-routes.ts').ApiContext & Record<string, unknown> = {
      daemonStartedAt: Date.now(),
      healthMonitor,
      agentService,
      config: jarvisConfig,
      wsService,
      channelService,
      authorityEngine,
      approvalManager,
      auditTrail,
      learner,
      emergencyController,
      deferredExecutor,
      awarenessService: null as any,
      goalService: undefined,
      sidecarManager,
      settingsReload,
      // Lets the hosted push bridge's doorbell poll on demand. `?? undefined`
      // rather than a cast: when observers are not running there is genuinely
      // nothing to sync, and the webhook says so.
      observerService: observerService ?? undefined,
    };
    setCorsOrigin(externalOrigin.httpOrigin);
    wsService.getServer().setCorsOrigin(externalOrigin.httpOrigin);

    // Construct the workflow runtime's shared collaborators early so the
    // route table can carry a TriggerManager reference (used for cron /
    // webhook / on_event registration after API mutations) and the worker
    // can pass the SAME event bus + runner instances into piece services.
    const sharedEventBus = new WorkflowEventBus();

    // Recent-events buffer: the daemon mirrors every workflow-bus publish
    // into this so the engine-managed `on_event` polling trigger sees the
    // same stream that legacy direct subscribers do.
    const workflowEventBuffer = new WorkflowEventBuffer();
    sharedEventBus.setObserver((eventType, payload) => {
      workflowEventBuffer.publish(eventType, payload);
    });

    // System cron: publishes `cron.morning` / `cron.evening` / `cron.hourly`
    // events onto the shared bus. Phase 2 hooks the goal system / commitment
    // executor / chat-stale watcher onto these so the 15-min heartbeat can
    // be deleted; for now nothing subscribes and the events are inert.
    const { SystemCronService } = await import('./system-cron.ts');
    systemCron = new SystemCronService(sharedEventBus, jarvisConfig.cron);
    systemCron.start();

    // Hosted usage warnings: three-quarters used, and used up, for each of the
    // two windows the proxy enforces. Registered even on a self-hosted install
    // — the reader answers null there, so the pass is a no-op and costs one
    // config read every 15 minutes, which is cheaper than deciding whether to
    // register it from a config that can change under SIGHUP.
    const { UsageAlertsService } = await import('./usage-alerts-service.ts');
    usageAlerts = new UsageAlertsService({
      getConfig: () => jarvisConfig,
      notify: notifyAll,
      canNotify: () => sidecarManager.getConnectedSidecars().length > 0,
    });
    usageAlerts.start();
    // A pass with no sidecar connected leaves its flags unset on purpose, so
    // the warning survives — but it would then wait up to fifteen minutes for
    // the next tick. Re-check as soon as a machine appears, which is exactly
    // when someone is there to read it. The 60s reader cache makes a reconnect
    // storm cost one upstream request, and the flags make a duplicate pass a
    // no-op.
    sidecarManager.onSidecarConnected(() => {
      void usageAlerts?.check().catch(() => {});
    });

    // Prime the realtime plan verdict before anyone speaks. Realtime is now on
    // by default for hosted tenants, so the gate decides for every hosted
    // install — and with a cold cache GET /api/config/voice reports
    // "available", which puts the browser into raw-PCM capture. On a plan
    // WITHOUT realtime that first utterance is refused and its frames dropped,
    // so the user speaks and nothing happens. One catalog request at boot
    // removes it, and it is issued here — well before registry.startAll()
    // binds any listener — so the dashboard's first poll already has a verdict.
    const warmRealtime = () => warmRealtimeGateFor(() => {
      const rtCfg = agentService.getConfig();
      return resolveRealtimeVoice(rtCfg, realtimeEnablement(rtCfg));
    });
    warmRealtime();
    // And again after every SIGHUP reload, which clears the verdict cache. A
    // reload arriving BEFORE this line is registered simply has no warm; the
    // miss-triggered fetch in cachedRealtimeVerdict covers that gap, which is
    // why that fetch exists rather than warming being the only defence.
    settingsReload.setWarmRealtime(warmRealtime);

    // Bootstrap the workflow engine: build/locate the bundle, compile pieces,
    // start the loopback SandboxApi, construct the EngineRuntime, extract the
    // canonical PieceCatalog. /v1/jarvis/* service backends are wired below
    // after registry.startAll() so toolRegistry + notifier dependencies are
    // ready; until then each backend returns 503 (mutation via
    // api.setServices propagates to live route handlers).
    //
    // Bootstrap failure is non-fatal for the daemon as a whole: workflows
    // are one feature among many (agent, vault, observers, sidecar) and a
    // bundle / extraction failure shouldn't take all of them offline. We log
    // a structured error with hints, leave `engineBoot` null, and the
    // workflow routes / trigger manager / executor are skipped below; other
    // services keep running.
    let engineBoot: BootstrapWorkflowEngineResult | null = null;
    const bootstrapStart = Date.now();
    // Build the credential resolver early so we can register Jarvis-managed
    // sources (Google OAuth file, etc.) before pieces start asking for
    // connections. Each `jarvis:<source>` external id dispatches to the
    // matching source; non-prefixed ids fall through to the `app_connection`
    // repo (encrypted at rest).
    const credentialResolver = new CredentialResolver();
    {
      // Registered unconditionally with a getter reading the live
      // `googleAuth` binding: the settings hot-reload google applier
      // reassigns it (connect mid-run, cred rotation, disconnect), and the
      // source resolves to null while it's absent/unauthenticated.
      const { JarvisGoogleConnectionSource } = await import(
        "../workflows/credentials/google-source.ts"
      );
      credentialResolver.register(new JarvisGoogleConnectionSource(() => googleAuth));
      logWithTimestamp(
        "Workflow credential resolver: registered jarvis:google source",
      );
    }
    // jarvis:telegram bridges the same bot token the daemon's Telegram
    // adapter is using -- pieces (activepieces telegram-bot, custom flows)
    // can reference `jarvis:telegram` instead of asking the user to create
    // a separate app_connection. The closure reads from the live config so
    // a token rotation + daemon restart picks up automatically.
    if (jarvisConfig.channels?.telegram?.enabled && jarvisConfig.channels.telegram.bot_token) {
      const { JarvisTelegramConnectionSource } = await import(
        "../workflows/credentials/telegram-source.ts"
      );
      credentialResolver.register(
        new JarvisTelegramConnectionSource(
          () => jarvisConfig.channels?.telegram?.bot_token ?? null,
        ),
      );
      logWithTimestamp(
        "Workflow credential resolver: registered jarvis:telegram source",
      );
    }
    // Ready-made workflow-runtime artifact paths (workflows.engine_dir /
    // pieces_dir / piece_metadata_cache, with ${version} expansion; env vars
    // as fallback). Resolved ONCE and passed everywhere (bootstrap, Library
    // routes, uninstall revert) so the whole daemon agrees on the paths.
    const sharedRuntime = resolveSharedRuntimePaths(jarvisConfig);
    for (const w of sharedRuntime.warnings) {
      logWithTimestamp(`[shared-runtime] WARNING: ${w}`);
    }
    try {
      engineBoot = await bootstrapWorkflowEngine({
        services: {
          credentialResolver,
          // eventsPoll is the only backend safely wireable up front (no
          // dependency on toolRegistry / agentService). The rest land via
          // api.setServices() after registry.startAll().
          eventsPoll: async (req) => {
            const reply = workflowEventBuffer.poll(req);
            return {
              events: reply.events.map((ev) => ({
                id: String(ev.id),
                eventType: ev.eventType,
                payload: ev.payload,
                timestamp: ev.timestamp,
              })),
              cursor: reply.cursor,
            };
          },
        },
        log: (line) => console.log(`[Daemon] ${line}`),
        engineIdleTtlMs: resolveEngineIdleTtlMs(jarvisConfig.workflows?.engineIdleTtlMs),
        sharedPiecesDir: sharedRuntime.piecesDir,
        sharedCacheFile: sharedRuntime.metadataCacheFile,
        engineCacheRoot: sharedRuntime.engineCacheRoot,
      });
      workflowEngineShutdown = engineBoot.shutdown;
      logWithTimestamp(
        `Workflow engine bootstrap: ${engineBoot.catalog.list().length} piece(s) catalog'd, ${engineBoot.failures.length} failure(s) in ${Date.now() - bootstrapStart}ms`,
      );
      // Surface the artifact identity so users who forgot to rebuild
      // after editing a piece or the framework see a stale hash at a
      // glance. Fix is documented in the build:workflows script.
      logWithTimestamp(
        `Workflow engine artifacts: bundle=${engineBoot.bundleHash} catalog-cache-key=${engineBoot.catalogCacheKey.slice(0, 16)} (rebuild: bun run build:workflows)`,
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(
        [
          `[Daemon] Workflow engine failed to start (${Date.now() - bootstrapStart}ms): ${err.message}`,
          `         Common causes:`,
          `           - Engine bundle / pieces stale or build failed: rerun \`bun install\` then \`bun run build:workflows\``,
          `           - Vendored Activepieces tree out of sync: rerun \`bun run scripts/sync-activepieces.ts\``,
          `           - Disk full or ~/.jarvis/cache unwriteable`,
          `         Workflow features (/api/workflows/*, manage_workflow tool, cron + on_event triggers) are disabled.`,
          `         The rest of the daemon (agent, vault, observers) continues to run.`,
        ].join("\n"),
      );
      if (err.stack) console.error(err.stack);
    }

    // Local var is the concrete `PieceCatalog` (not the structural `PieceLookup`)
    // so the `onPieceLibraryChanged` callback can call `upsert()` / `remove()`
    // after runtime installs.
    const workflowPieceCatalog = engineBoot?.catalog ?? null;
    const workflowEngineRuntime = engineBoot?.runtime ?? null;
    const workflowSandboxApi = engineBoot?.api ?? null;

    // Build the trigger manager. With the engine runtime present, polling
    // triggers go through EXECUTE_TRIGGER_HOOK(ON_ENABLE); without it the
    // manager's `engineRuntime` slot is unset and on_event flows fall back
    // to direct event-bus subscription.
    triggerManager = new TriggerManager({
      eventBus: sharedEventBus,
      ...(workflowEngineRuntime ? { engineRuntime: workflowEngineRuntime } : {}),
    });

    // Mount the daemon's existing routes plus the workflow runtime's routes.
    // The legacy in-house workflow routes that lived at /api/workflows/* were
    // removed in the Phase 6 cutover; the new runtime now owns those paths.
    // onPieceLibraryChanged: extract metadata for a newly-installed piece
    // and upsert into the running catalog so the flow editor picks it up
    // without a daemon restart. Skipped if either the catalog or the engine
    // runtime is missing (engine bootstrap failed earlier -- the install
    // route still mutated disk; the next daemon start reconciles).
    const onPieceLibraryChanged =
      workflowPieceCatalog && workflowEngineRuntime
        ? async (event: {
            kind: "installed" | "uninstalled";
            piece: { npmPackage: string; resolvedVersion: string };
          }) => {
            // Only ever reached on a SELF-MANAGED install: the Library
            // mutations that fire this are refused when a host owns the
            // catalog, and a host owning the catalog is exactly what having a
            // shared tree means. So an uninstall here has no shared copy to
            // fall back to — the piece is simply gone.
            if (event.kind === "uninstalled") {
              workflowPieceCatalog.remove(event.piece.npmPackage);
              return;
            }
            // Unique runId per acquire so any future parallel installs
            // (today serialized by the API's library mutex) don't collide on
            // the engine's runId-keyed state.
            const handle = await workflowEngineRuntime.acquire({
              runId: `metadata-extract-runtime-install-${apId()}`,
              projectId: DEFAULT_IDS.project,
            });
            try {
              const meta = await handle.extractPieceMetadata({
                pieceName: event.piece.npmPackage,
                pieceVersion: event.piece.resolvedVersion,
              });
              workflowPieceCatalog.upsert(metadataToCatalogEntry(meta));
            } finally {
              await handle.release();
            }
          }
        : undefined;

    const apiRoutes = {
      ...createApiRoutes(apiContext),
      ...createWorkflowRoutes({
        triggerManager,
        credentialResolver,
        ...(workflowPieceCatalog ? { pieceRegistry: workflowPieceCatalog } : {}),
        sharedPiecesDir: sharedRuntime.piecesDir,
        ...(onPieceLibraryChanged ? { onPieceLibraryChanged } : {}),
        getEventBufferDropped: () => workflowEventBuffer.dropped(),
      }),
    };
    wsService.setApiRoutes(apiRoutes);

    // Serve dashboard from ui/dist/
    wsService.setStaticDir(uiDistDir);

    // Serve public assets (wake word models, WASM) from ui/public/
    const uiPublicDir = path.join(import.meta.dir, '../../ui/public');
    wsService.setPublicDir(uiPublicDir);

    // 9c. Access model. JWT-only by default: the dashboard and every API
    // route require a valid enrolled-device token. The one escape hatch is
    // auth.insecure_open_access (system config), meant ONLY for first-time
    // self-host setup before a device is enrolled.
    if (jarvisConfig.auth?.insecure_open_access === true) {
      wsService.setInsecureOpenAccess(true);
      console.warn('[Daemon] ============================================================');
      console.warn('[Daemon] WARNING: auth.insecure_open_access is enabled.');
      console.warn('[Daemon] The dashboard and API accept requests WITHOUT authentication');
      console.warn('[Daemon] from anyone who can reach this machine. Enroll your device');
      console.warn('[Daemon] (`jarvis enroll "<device-name>"`, paste the token into the');
      console.warn('[Daemon] sidecar) and remove this flag from config.yaml as soon as');
      console.warn('[Daemon] enrollment is done.');
      console.warn('[Daemon] ============================================================');
    } else {
      console.log('[Daemon] JWT-only access: routes require an enrolled device token (default)');
    }
    // Upgrade UX: the shared dashboard token was removed (JWT-only). A config
    // still carrying auth.token would otherwise be silently ignored while the
    // operator's bookmarked ?token= URL just 401s.
    if ((jarvisConfig.auth as Record<string, unknown> | undefined)?.token !== undefined) {
      console.warn('[Daemon] auth.token is no longer supported and was ignored. Access is JWT-only:');
      console.warn('[Daemon] enroll a device (`jarvis enroll`) or, for setup only, set auth.insecure_open_access.');
    }

    // 9b. Apply --no-local-tools flag if set
    if (config.noLocalTools) {
      const { setNoLocalTools } = await import('../actions/tools/builtin.ts');
      setNoLocalTools(true);
    }

    // 9b'. browser.local: false (system config) - never launch a local
    // Chrome on this machine. Hosted instances set this so no CDP port can
    // open on a shared VPS; browser actions route to a sidecar browser
    // (launchChrome is the enforcement choke point).
    if (jarvisConfig.browser?.local === false) {
      const { setLocalBrowserDisabled } = await import('../actions/tools/local-tools-guard.ts');
      setLocalBrowserDisabled(true);
    }

    // 10. Start all services
    await registry.startAll();

    // 10a-post. Wire authority components that need running services
    const toolRegistry = orchestrator.getToolRegistry();
    if (toolRegistry) {
      deferredExecutor.setToolRegistry(toolRegistry);

      // Register the request_approval intent-gating tool now that approval
      // infrastructure is wired. Registered here (not in agent-service) because
      // the tool needs both approvalManager and approvalDelivery, which are
      // owned by the daemon composition root.
      const { createRequestApprovalTool } = await import('../actions/tools/approval-tool.ts');
      const requestApprovalTool = createRequestApprovalTool({
        approvalManager,
        approvalDelivery,
        getCurrentAgent: () => {
          const primary = orchestrator.getPrimary();
          if (!primary) return null;
          return { id: primary.id, name: primary.agent.role.name };
        },
      });
      if (!toolRegistry.has('request_approval')) {
        toolRegistry.register(requestApprovalTool);
        console.log('[Daemon] Registered request_approval intent-gate tool');
      }

      // Register manage_workflow so the primary agent can list / run / create
      // workflows from chat. Wired here so the trigger manager (constructed
      // earlier in step 10.1) is in scope and refreshes happen on enable /
      // disable / publish / delete.
      const { createManageWorkflowTool } = await import('../actions/tools/manage-workflow.ts');
      // Build a minimal piece-side LLM client + tool-registry shim for the
      // composer. Both are tiny structural wrappers; we no longer need the
      // legacy `JarvisLlmClient`/`JarvisToolRegistryAdapter` classes since
      // the engine path is the production runtime.
      const llmManager = agentService.getLLMManager();
      const composeLlm = {
        async chat(input: { prompt: string; system?: string }): Promise<{ text: string }> {
          const messages: Array<{ role: "system" | "user"; content: string }> = [];
          if (input.system !== undefined) messages.push({ role: "system", content: input.system });
          messages.push({ role: "user", content: input.prompt });
          // Composer expects a complete JSON tree describing the flow.
          // A realistic flow is 500-2000 output tokens; we ask for 8192
          // to leave room for verbose pieces (long input schemas, many
          // steps) without surprise truncation -- kept consistent with the
          // chatTools cap below. Ollama's default `num_predict` is 128 --
          // truncates every compose reply mid-JSON and crashes parsing with
          // "Unexpected EOF". Other providers either have higher defaults or
          // ignore the cap.
          const reply = await llmManager.chat(messages, { max_tokens: 8192 });
          // `LLMResponse.content` is the assistant-text field; an earlier
          // version of this adapter read `reply.text` which doesn't
          // exist on the provider response shape, so every compose
          // returned "" and JSON.parse crashed with EOF. Stay strict
          // here -- if the provider ever returns ContentBlock[] for
          // text-only completions we want to know.
          const content = typeof reply.content === "string" ? reply.content : "";
          return { text: content };
        },
        // Tool-loop entrypoint: the composer discovers pieces via tools
        // (list_pieces / get_piece_details / ...) instead of a full catalog
        // dump. ComposerChatMessage / ComposerToolDef alias LLMMessage /
        // LLMTool, so this is a passthrough. If the provider rejects the tools
        // parameter, the composer catches the error and falls back to the
        // one-shot `chat` path above. `finish_reason` is surfaced so the loop
        // can detect a reply truncated at the token cap (a dropped submit_flow)
        // rather than misreading it as prose.
        async chatTools(
          messages: ComposerChatMessage[],
          tools: ComposerToolDef[],
        ): Promise<ComposerChatReply> {
          const reply = await llmManager.chat(messages, {
            max_tokens: 8192,
            tools,
            tool_choice: 'auto',
          });
          return {
            content: typeof reply.content === 'string' ? reply.content : '',
            tool_calls: reply.tool_calls ?? [],
            finish_reason: reply.finish_reason,
          };
        },
      };
      // Compact community-library index for the composer's search_library
      // tool: lets it suggest "install piece X first" when the user asks for
      // a service that isn't installed, instead of forcing a wrong fit.
      //
      // Withheld on a HOST-MANAGED install, where that suggestion is a
      // dead end. The host installed the whole catalog, so every piece the
      // engine could actually run is already in the registry list_pieces
      // reads; the only ids this index could still flag "not installed" are
      // ones whose metadata extraction failed on the host — which the tenant
      // can neither install (the API answers 403) nor repair. Passing no
      // library also strips search_library from the composer's tool loop and
      // the suggest-install wording from both prompts, so the agent stops
      // telling hosted users to visit a Library page that has no button.
      const { CATALOG: piecesLibraryCatalog } = await import('../workflows/pieces-library/catalog.ts');
      const { piecesManagedByHost } = await import('../workflows/pieces-library/shared.ts');
      const composerLibrary = piecesManagedByHost(sharedRuntime.piecesDir)
        ? []
        : piecesLibraryCatalog.map((e) => ({
            id: e.id,
            npmPackage: e.npmPackage,
            displayName: e.displayName,
            description: e.description,
          }));
      const composerToolRegistry = toolRegistry
        ? {
            listNames: (cat?: string) => toolRegistry.list(cat).map((t) => t.name),
            // Surface each tool's parameter schema so the composer can wire
            // correct `params` and reject a jarvis-tool:invoke step that omits a
            // required param (e.g. content_pipeline needs `action`).
            listDetailed: (cat?: string) =>
              toolRegistry.list(cat).map((t) => ({
                name: t.name,
                description: t.description,
                params: Object.entries(t.parameters).map(([name, p]) => ({
                  name,
                  type: p.type,
                  required: p.required,
                  description: p.description,
                })),
              })),
          }
        : undefined;
      const manageWorkflowTool = createManageWorkflowTool({
        triggerManager: triggerManager ?? undefined,
        llm: composeLlm,
        ...(workflowPieceCatalog ? { pieceRegistry: workflowPieceCatalog } : {}),
        // Surface tool names to the composer so the LLM can compose flows
        // that integrate with services that aren't first-class pieces (e.g.,
        // Gmail/Calendar via Jarvis tools).
        ...(composerToolRegistry ? { toolRegistry: composerToolRegistry } : {}),
        // Surface the discovered specialist roles so a composed delegate step
        // can only reference a sub-agent that exists (the LLM otherwise guesses
        // ids like "researcher" that have no role file). Thunk so it reflects
        // whatever agentService discovered, regardless of init ordering.
        specialistRoles: () =>
          Array.from(agentService.getSpecialists().values()).map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
          })),
        library: composerLibrary,
      });
      if (!toolRegistry.has('manage_workflow')) {
        toolRegistry.register(manageWorkflowTool);
        console.log('[Daemon] Registered manage_workflow tool');
      }
    }
    approvalDelivery.setBroadcaster(wsService);
    approvalDelivery.setChannelSender(channelService);
    channelService.setDeliveryFailureHandler(({ channel, attempts, error }) => {
      // 'normal', not 'urgent': urgent notifications are echoed back to
      // external channels, which would loop the failure into the channel
      // that just failed. The dashboard is the fallback the user still has.
      wsService.broadcastNotification(
        `Could not deliver message to ${channel} after ${attempts} attempt(s): ${error}`,
        'normal',
      );
    });
    deferredExecutor.setResultCallback((requestId, request, result) => {
      // Notify via WS and channels that an approved action was executed.
      // Skip for intent-only approvals — they have no deferred execution.
      // Skip for inline approvals too: their result returns through the
      // task loop and the conversation tier verbalizes it, so a raw
      // notification would duplicate it in the chat.
      if (request.tool_name === 'request_approval') return;
      if (request.execution_mode === 'inline') return;
      const text = `[EXECUTED] ${request.tool_name}: ${result.slice(0, 200)}`;
      wsService.broadcastNotification(text, 'normal');
    });

    // 10.1. Workflow runtime: wire `/v1/jarvis/*` service backends and start
    // the worker that drains workflow_job, driven by the engine-backed
    // executor. Skipped entirely when `workflowEngineRuntime` is null (engine
    // bootstrap failed earlier; we logged a structured error there).
    if (workflowSandboxApi && workflowEngineRuntime) {
      // M7 hookup: pass orchestrator + specialists + authority components so
      // `jarvis-agent.delegate` runs the full sub-agent loop (LLM + tool
      // calls + authority gate). Falls back to single-shot LLM mode inside
      // buildSandboxServiceBackends if any of these are missing.
      const agentSpecialists = agentService.getSpecialists();
      const backends = buildSandboxServiceBackends({
        credentialResolver: workflowSandboxApi.services.credentialResolver,
        llmManager: agentService.getLLMManager(),
        ...(toolRegistry ? { toolRegistry } : {}),
        channelService,
        wsService,
        eventBuffer: workflowEventBuffer,
        sendDesktop: async (title, body) => {
          sendDesktopNotification(title, body, { urgency: 'normal' });
        },
        agentOrchestrator: agentService.getOrchestrator(),
        agentSpecialists,
        authorityEngine,
        auditTrail,
        emergencyController,
        // Give the jarvis-ask piece the same Jarvis-flavoured system
        // prompt the chat agent uses, so workflow LLM calls answer as
        // Jarvis rather than as the bare base model. `"workflow"` is the
        // channel slug -- not a real channel, just a key for personality
        // overrides if any are configured.
        buildJarvisSystemPrompt: (userMessage) =>
          agentService.buildFullSystemPromptParts("workflow", userMessage),
      });
      workflowSandboxApi.setServices(backends);
      logWithTimestamp("Workflow engine service backends wired (llm/tools/notify/context/agent/events/workflows)");

      // Boot recovery: re-queue any run orphaned RUNNING by a prior crash /
      // over-deadline drain so it resumes NOW, not after the lease lapses.
      const recovered = recoverOrphanedJobs();
      if (recovered > 0) logWithTimestamp(`Recovered ${recovered} orphaned workflow job(s) for resume`);

      const flowExecutor = new EngineFlowExecutor(workflowEngineRuntime);
      workflowWorker = new WorkflowWorker({
        handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: flowExecutor }) },
      });
      workflowWorker.start();

      // Resume TIMER waitpoints whose delay has elapsed (incl. during downtime).
      timerScheduler = new TimerWaitpointScheduler();
      timerScheduler.start();
    } else {
      console.warn("[Daemon] Workflow worker not started -- engine unavailable; queued RUN_FLOW jobs will pile up");
    }

    // Start the trigger manager: scan ENABLED flows and register cron /
    // webhook / on_event subscriptions. From this point on, any flow whose
    // status flips ENABLED via the v2 API gets reconciled by the route
    // hooks calling `triggerManager.refresh(flowId)`.
    await triggerManager.start();
    logWithTimestamp(`Trigger manager started with ${triggerManager.list().length} active subscription(s)`);

    // 10.2. Republish observer events onto the workflow event bus so flows
    // with `on_event` triggers can fire. Event-type strings follow the
    // canonical taxonomy in src/workflows/runtime/event-types.ts: each
    // observer event becomes `observer.<observer_type>` (where the observer's
    // raw `type` is normalized to snake_case via mapObserverEventType).
    if (observerService) {
      const warnedRawTypes = new Set<string>();
      observerService.setForwardCallback((event) => {
        const mapped = OBSERVER_EVENT_TYPE_MAP[event.type];
        const canonical = mapped ?? `observer.${event.type}`;
        if (!mapped && !warnedRawTypes.has(event.type)) {
          warnedRawTypes.add(event.type);
          console.warn(
            `[Daemon] Observer emitted unknown raw type "${event.type}" — publishing as "${canonical}" but it is not in WORKFLOW_EVENT_TYPES; add a mapping in src/workflows/runtime/event-types.ts so the composer surfaces it.`,
          );
        }
        sharedEventBus.publish(canonical, { ...event.data, _timestamp: event.timestamp });
      });
    }

    // Phase A — onboarding setup-mode guard for LLM-dependent services.
    // While `setup_completed_at === null` the user hasn't saved an LLM
    // provider/key/model yet, so the heartbeat-driven background agent,
    // commitment executor, and awareness service have nothing to call.
    //
    // The construction logic lives in `startPostSetupServices` below so it
    // can be invoked in TWO places: here at boot (when setup was already
    // completed in a prior run) AND from the `/api/onboarding/setup`
    // endpoint right after the user finishes onboarding — so the daemon
    // does NOT need to be restarted for background services to come
    // online. Critical for Docker/VPS deploys where a process restart
    // breaks WS connections, sidecars, and watchers.
    const inSetupMode = !jarvisConfig.onboarding?.setup_completed_at;
    if (inSetupMode) {
      console.log('[Daemon] Setup mode — bgAgent / executor / awareness will start when onboarding completes');
    }

    // Idempotent constructor for the LLM-dependent services. Safe to call
    // multiple times; returns immediately if `bgAgent` is already running.
    const startPostSetupServices = async (): Promise<void> => {
      if (bgAgent) return; // already running

      // 10b. Background agent (needs LLM providers from agentService.start())
      const bgAgentService = new BackgroundAgentService(jarvisConfig, agentService.getLLMManager());
      bgAgentService.setResearchQueue(researchQueue);
      await bgAgentService.start();
      bgAgent = bgAgentService;
      console.log('[Daemon] Background agent started (separate browser for heartbeat/reactions)');

      // 10c. Wire reactor + executor to background agent
      reactor.setAgentService(bgAgentService);
      executor.setAgentService(bgAgentService);

      // 10d. Wire executor broadcast (needs wsServer running) and start
      executor.setBroadcast((msg) => wsService.getServer().broadcast(msg));
      executor.setEventBus(sharedEventBus);
      wsService.setCommitmentExecutor(executor);
      executor.start();
      commitmentExecutor = executor;

      // 10e. Awareness Service (M13). Skipped when --no-local-tools is set
      //       (headless / Docker) or explicitly disabled in config.
      if (jarvisConfig.awareness?.enabled !== false && !config.noLocalTools) {
        await startAwarenessService();
      }
    };

    // Awareness service construction extracted so the post-setup helper
    // can call it conditionally. Closes over the same boot-scope deps as
    // the original inline block.
    const startAwarenessService = async (): Promise<void> => {
      if (awarenessService) return;
      try {
        const { AwarenessService } = await import('../awareness/service.ts');
        const awarenessWarnedTypes = new Set<string>();
        const svc = new AwarenessService(
          jarvisConfig,
          agentService.getLLMManager(),
          (event) => {
            // Route awareness events through existing event pipeline
            const classified = classifyEvent({
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
            if (classified.priority === 'critical' || classified.priority === 'high') {
              reactor.react(classified).catch(err =>
                console.error('[Daemon] Awareness reaction error:', err)
              );
            } else {
              coalescer.addEvent(classified);
            }
            // Broadcast to WebSocket clients
            wsService.broadcastAwarenessEvent(event);

            // Republish onto the workflow event bus so flows with `on_event`
            // triggers (awareness.context_changed, awareness.suggestion_ready, etc.)
            // can fire on real awareness state. Unknown raw types warn once + fall
            // back to `awareness.<rawType>` so the bus side never drops events.
            const mapped = AWARENESS_EVENT_TYPE_MAP[event.type];
            const canonical = mapped ?? `awareness.${event.type}`;
            if (!mapped && !awarenessWarnedTypes.has(event.type)) {
              awarenessWarnedTypes.add(event.type);
              console.warn(
                `[Daemon] AwarenessService emitted unknown raw type "${event.type}" — publishing as "${canonical}" but it is not in WORKFLOW_EVENT_TYPES; add a mapping in src/workflows/runtime/event-types.ts so the composer surfaces it.`,
              );
            }
            sharedEventBus.publish(canonical, { ...event.data, _timestamp: event.timestamp });

            // Push suggestions as chat notifications + voice + desktop
            if (event.type === 'suggestion_ready') {
              const title = String(event.data.title ?? '');
              const body = String(event.data.body ?? '');
              const text = `**${title}**\n${body}`;
              console.log(`[Daemon] Awareness suggestion firing: "${title}"`);

              const hasWsClients = wsService.getServer().getClientCount() > 0;

              if (hasWsClients) {
                // Primary: deliver via WebSocket + voice
                wsService.broadcastNotification(text, 'urgent');
                sendDesktopNotification(`JARVIS: ${title}`, body, { urgency: 'normal' });
                wsService.broadcastProactiveVoice(body).catch(err =>
                  console.error('[Daemon] Awareness TTS error:', err)
                );
              } else {
                // Fallback: no dashboard clients — deliver via external channels + persistent desktop
                console.log('[Daemon] No WS clients — routing suggestion to external channels');
                channelService.broadcastToAll(text).catch(err =>
                  console.error('[Daemon] Channel broadcast error:', err)
                );
                sendDesktopNotification(`JARVIS: ${title}`, body, { urgency: 'critical', expireMs: 30000 });
              }
            }

            // Auto-research errors: silently investigate and deliver solution
            if (event.type === 'error_detected' && bgAgent) {
              const errorText = String(event.data.errorText ?? '');
              const appName = String(event.data.appName ?? '');
              if (errorText.length > 5) {
                console.log(`[Daemon] Auto-researching error: "${errorText.slice(0, 80)}"`);
                bgAgent.handleMessage(
                  `The user is seeing this error in ${appName}: "${errorText}". ` +
                  `Search the web and vault for a solution. Be concise and actionable. ` +
                  `Start your response with the fix, not a question.`,
                  'awareness'
                ).then(solution => {
                  if (solution && solution.length > 10) {
                    const solutionText = `**Fix for error in ${appName}:**\n${solution.slice(0, 500)}`;
                    wsService.broadcastNotification(solutionText, 'urgent');
                    sendDesktopNotification(`JARVIS: Fix for ${appName}`, solution.slice(0, 200), { urgency: 'critical', expireMs: 15000 });
                    // Strip markdown for TTS — voice should sound natural
                    const voiceText = solution
                      .replace(/#{1,6}\s*/g, '')
                      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
                      .replace(/`([^`]+)`/g, '$1')
                      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                      .replace(/\n{2,}/g, '. ')
                      .replace(/\n/g, ' ')
                      .replace(/\s{2,}/g, ' ')
                      .trim()
                      .slice(0, 300);
                    console.log(`[Daemon] Speaking error solution (${voiceText.length} chars): "${voiceText.slice(0, 80)}..."`);
                    wsService.broadcastProactiveVoice(
                      `I found a fix for the error in ${appName}. ${voiceText}`
                    ).then(() =>
                      console.log('[Daemon] Error solution TTS delivered')
                    ).catch(err =>
                      console.error('[Daemon] Error solution TTS failed:', err instanceof Error ? err.message : err)
                    );
                  }
                }).catch(err =>
                  console.error('[Daemon] Error auto-research failed:', err instanceof Error ? err.message : err)
                );
              }
            }

            // Deep-research struggles: for high-confidence code/terminal struggles
            if (event.type === 'struggle_detected' && bgAgent) {
              const appCategory = String(event.data.appCategory ?? 'general');
              const sAppName = String(event.data.appName ?? '');
              const ocrPreview = String(event.data.ocrPreview ?? '');
              const compositeScore = event.data.compositeScore as number;

              if (compositeScore >= 0.7 && (appCategory === 'code_editor' || appCategory === 'terminal')) {
                console.log(`[Daemon] Deep-researching struggle in ${sAppName} (score: ${compositeScore.toFixed(2)})`);
                bgAgent.handleMessage(
                  `The user has been struggling in ${sAppName} (${appCategory}) for several minutes. ` +
                  `Here's what's on their screen:\n"${ocrPreview.slice(0, 800)}"\n\n` +
                  `Search for solutions to any errors visible. Check documentation for the relevant language/framework. ` +
                  `Provide a specific, actionable fix. Start with the solution, not a question.`,
                  'awareness'
                ).then(solution => {
                  if (solution && solution.length > 10) {
                    const solutionText = `**Help for ${sAppName}:**\n${solution.slice(0, 500)}`;
                    wsService.broadcastNotification(solutionText, 'urgent');
                    sendDesktopNotification(`JARVIS: Help for ${sAppName}`, solution.slice(0, 200), { urgency: 'critical', expireMs: 15000 });
                    const voiceText = solution
                      .replace(/#{1,6}\s*/g, '')
                      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
                      .replace(/`([^`]+)`/g, '$1')
                      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                      .replace(/\n{2,}/g, '. ')
                      .replace(/\n/g, ' ')
                      .replace(/\s{2,}/g, ' ')
                      .trim()
                      .slice(0, 300);
                    wsService.broadcastProactiveVoice(
                      `I found something that might help with what you're working on in ${sAppName}. ${voiceText}`
                    ).catch(err =>
                      console.error('[Daemon] Struggle solution TTS failed:', err instanceof Error ? err.message : err)
                    );
                  }
                }).catch(err =>
                  console.error('[Daemon] Struggle auto-research failed:', err instanceof Error ? err.message : err)
                );
              }
            }

            // M16: Route awareness events to goal auto-detection
            if (goalService && (event.type === 'context_changed' || event.type === 'session_ended')) {
              try {
                const { matchAwarenessToGoals, logAutoDetectedProgress } = require('../goals/awareness-bridge.ts');
                const matches = matchAwarenessToGoals(event.data);
                if (matches.length > 0) {
                  logAutoDetectedProgress(matches, event.type);
                }
              } catch (err) {
                // Silently ignore — goal matching is best-effort
              }
            }
          },
          // Delegating wrapper (not the instance): the settings hot-reload
          // google applier reassigns `googleAuth`, and the suggestion engine
          // holds this reference for the service's whole lifetime.
          {
            isAuthenticated: () => googleAuth?.isAuthenticated() ?? false,
            getAccessToken: () => {
              if (!googleAuth) return Promise.reject(new Error('Google not configured'));
              return googleAuth.getAccessToken();
            },
          },
          async (sidecarId: string, imagePath: string) => {
            try {
              const result = await sidecarManager.dispatchRPC(sidecarId, 'fetch_capture', { path: imagePath }) as
                | (Record<string, unknown> & { _binary?: { type?: string; data?: string } | Buffer })
                | undefined;
              const binary = result?._binary;
              if (binary && typeof binary === 'object' && 'data' in binary && typeof binary.data === 'string') {
                return Buffer.from(binary.data, 'base64');
              }
              if (Buffer.isBuffer(binary)) {
                return binary;
              }
              return null;
            } catch (err) {
              console.error('[Daemon] fetch_capture RPC failed:', err instanceof Error ? err.message : err);
              return null;
            }
          },
          async (cutoffMs: number) => {
            const all = sidecarManager.listSidecars();
            const connected = all.filter(s => s.connected);
            const offline = all.length - connected.length;

            let totalFiles = 0;
            let totalDirs = 0;
            await Promise.all(connected.map(async (s) => {
              try {
                const result = await sidecarManager.dispatchRPC(s.id, 'cleanup_captures', { before_ms: cutoffMs }) as
                  | { files_deleted?: number; dirs_removed?: number }
                  | undefined;
                totalFiles += result?.files_deleted ?? 0;
                totalDirs += result?.dirs_removed ?? 0;
              } catch (err) {
                console.error(`[Daemon] cleanup_captures on ${s.id} failed:`, err instanceof Error ? err.message : err);
              }
            }));

            if (totalFiles > 0 || totalDirs > 0) {
              console.log(`[Daemon] Sidecar capture cleanup: ${totalFiles} files, ${totalDirs} dirs across ${connected.length} sidecar(s)`);
            }
            if (offline > 0) {
              console.log(`[Daemon] Sidecar capture cleanup: skipped ${offline} offline sidecar(s); their files will be pruned on reconnect`);
            }
          }
        );
        await svc.start();
        awarenessService = svc;
        apiContext.awarenessService = svc;
        console.log('[Daemon] Awareness service started (event-driven OCR + context tracking)');

        // Wire sidecar awareness events to awareness service
        sidecarManager.onEvent((sidecarId, event) => {
          if (['screen_capture', 'context_changed', 'idle_detected'].includes(event.event_type)) {
            svc.handleSidecarEvent(sidecarId, event).catch(err =>
              console.error('[Daemon] Awareness sidecar event error:', err instanceof Error ? err.message : err)
            );
          }
        });

        // On (re)connect, prune any capture files older than the longest
        // retention tier — catches files that piled up while the sidecar
        // was offline.
        sidecarManager.onConnect((sidecarId) => {
          const cfg = jarvisConfig.awareness;
          if (!cfg) return;
          const cutoffMs = Date.now() - cfg.retention.key_moment_hours * 60 * 60 * 1000;
          sidecarManager.dispatchRPC(sidecarId, 'cleanup_captures', { before_ms: cutoffMs })
            .then((result) => {
              const r = result as { files_deleted?: number; dirs_removed?: number } | undefined;
              const files = r?.files_deleted ?? 0;
              const dirs = r?.dirs_removed ?? 0;
              if (files > 0 || dirs > 0) {
                console.log(`[Daemon] On-connect cleanup on ${sidecarId}: ${files} files, ${dirs} dirs`);
              }
            })
            .catch((err) => {
              console.error(`[Daemon] On-connect cleanup_captures on ${sidecarId} failed:`, err instanceof Error ? err.message : err);
            });
        });

        // (Removed) The old-dashboard awareness overlay widget used to
        // auto-launch a Chromium window pointed at /overlay. It connected as a
        // WebSocket client, which made the daemon's proactive TTS play THROUGH
        // it — talking over the native pebble's realtime voice. The native
        // pebble is the awareness surface now, so the overlay is gone.
      } catch (err) {
        console.error('[Daemon] Awareness service failed to start:', err instanceof Error ? err.message : err);
        // Non-fatal — daemon continues without awareness
      }
    };

    // Expose the helper to the API layer so /api/onboarding/setup can
    // bring services online at the end of onboarding without a restart.
    apiContext.startPostSetupServices = startPostSetupServices;
    apiContext.isPostSetupServicesReady = () => bgAgent !== null;

    // Boot-time path: setup was completed in a prior run, so spin services
    // up now. Skipped in setup mode — the onboarding endpoint will call
    // the same helper when the user finishes.
    if (!inSetupMode) {
      await startPostSetupServices();
    }

    // 10a-2. Site Builder Service
    if (jarvisConfig.sites?.enabled !== false) {
      try {
        const { SiteBuilderService } = await import('../sites/service.ts');
        const sitesConfig = jarvisConfig.sites ?? {
          enabled: true,
          projects_dir: '~/.jarvis/projects',
          port_range_start: 4000,
          port_range_end: 4999,
          auto_commit: true,
          max_concurrent_servers: 3,
        };
        const siteBuilderService = new SiteBuilderService(sitesConfig);
        await siteBuilderService.start();
        apiContext.siteBuilderService = siteBuilderService;
        registry.register(siteBuilderService);

        // Wire proxy into WebSocket server for dev server HTTP/WS forwarding
        wsService.getServer().setSiteProxy(siteBuilderService.proxy);

        // Register builder tools into the agent's tool registry
        const { createSiteBuilderTools } = await import('../sites/builder-tools.ts');
        const builderTools = createSiteBuilderTools(siteBuilderService.projectManager, siteBuilderService.gitManager, siteBuilderService.githubManager);
        const toolReg = orchestrator.getToolRegistry();
        if (toolReg) {
          for (const tool of builderTools) toolReg.register(tool);
          console.log(`[Daemon] Registered ${builderTools.length} site builder tools`);
        }

        // Wire site builder into WebSocket service for project-scoped chat
        wsService.setSiteBuilderService(siteBuilderService);

        console.log('[Daemon] Site builder service started');
      } catch (err) {
        console.error('[Daemon] Site builder failed to start:', err instanceof Error ? err.message : err);
      }
    }

    // 10b. (legacy workflow engine deleted; the new runtime initialized above
    //       in step 10.1 owns all workflow execution.)

    // 10f. Goal Service (M16)
    const goalsConfig = jarvisConfig.goals;
    if (goalsConfig?.enabled !== false) {
      try {
        const { GoalService } = await import('../goals/service.ts');
        const goalSvc = new GoalService(goalsConfig ?? {
          enabled: true,
          morning_window: { start: 7, end: 9 },
          evening_window: { start: 20, end: 22 },
          accountability_style: 'drill_sergeant',
          escalation_weeks: { pressure: 1, root_cause: 3, suggest_kill: 4 },
          auto_decompose: true,
          calendar_ownership: false,
        }, sharedEventBus);
        goalSvc.setEventCallback((event) => {
          wsService.broadcastGoalEvent(event);
        });
        await goalSvc.start();
        goalService = goalSvc;
        apiContext.goalService = goalSvc;

        // (Goal -> workflow bridge for daily rhythm has been removed alongside
        // the legacy engine. Re-add as native flows in the new system if the
        // morning-plan / evening-review crons are still desired.)

        // Register manage_goals tool for chat agent
        try {
          const goalToolRegistry = orchestrator.getToolRegistry();
          if (goalToolRegistry) {
            const { createManageGoalsTool } = await import('../actions/tools/goals.ts');
            const { NLGoalBuilder } = await import('../goals/nl-builder.ts');
            const { GoalEstimator } = await import('../goals/estimator.ts');
            const { DailyRhythm } = await import('../goals/rhythm.ts');
            const { AccountabilityEngine } = await import('../goals/accountability.ts');
            const llm = agentService.getLLMManager();
            const style = goalsConfig?.accountability_style ?? 'drill_sergeant';
            const escWeeks = goalsConfig?.escalation_weeks ?? { pressure: 1, root_cause: 3, suggest_kill: 4 };
            const goalNlBuilder = new NLGoalBuilder(llm);
            const goalEstimator = new GoalEstimator(llm);
            const goalRhythm = new DailyRhythm(llm, style);
            const goalAccountability = new AccountabilityEngine(llm, style, escWeeks);
            const manageGoalsTool = createManageGoalsTool({
              goalService: goalSvc,
              nlBuilder: goalNlBuilder,
              estimator: goalEstimator,
              rhythm: goalRhythm,
              accountability: goalAccountability,
            });
            goalToolRegistry.register(manageGoalsTool);
            console.log('[Daemon] manage_goals tool registered for chat agent');

            // Wire DailyRhythm + chat delivery into GoalService for proactive reminders
            goalRhythm.setEventCallback((event) => wsService.broadcastGoalEvent(event));
            goalSvc.setRhythm(goalRhythm);
            goalSvc.setChatCallback((text) => wsService.broadcastHeartbeat(text));
          }
        } catch (err) {
          console.error('[Daemon] Failed to register manage_goals tool:', err instanceof Error ? err.message : err);
        }

        console.log('[Daemon] Goal service started (autonomous goal pursuit)');
      } catch (err) {
        console.error('[Daemon] Goal service failed to start:', err instanceof Error ? err.message : err);
        // Non-fatal — daemon continues without goals
      }
    }

    // 10g. Inject sidecar manager into tool routing layer
    {
      const { setSidecarManagerRef } = await import('../actions/tools/sidecar-route.ts');
      setSidecarManagerRef(sidecarManager);
      console.log('[Daemon] Sidecar routing enabled for run_command, read_file, write_file, list_directory');
    }

    // 10h. Wire sidecar events into the event pipeline (skip awareness events —
    // already handled by the awareness service).
    const awarenessEventTypes = ['screen_capture', 'context_changed', 'idle_detected'];

    // Host-sensing observers (clipboard, file watch, process monitor,
    // notifications) now run in the SIDECAR — the agent that actually lives on
    // the user's machine — instead of the brain. Map each sidecar event_type
    // back to the brain's raw observer type so the classifier rules, vault
    // observation types, and the `observer.*` workflow bus all keep working
    // exactly as they did when these observers ran in-process in the brain.
    const sidecarObserverTypeMap: Record<string, string> = {
      clipboard_change: 'clipboard',
      file_change: 'file_change',
      process_started: 'process_started',
      process_stopped: 'process_stopped',
      notification: 'notification',
    };
    const observerWarnedTypes = new Set<string>();

    sidecarManager.onEvent((sidecarId, event) => {
      // Skip events already routed to awareness service to avoid double processing
      if (awarenessService && awarenessEventTypes.includes(event.event_type)) return;

      const payloadObj: Record<string, unknown> =
        typeof event.payload === 'object' && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : { payload: event.payload };
      const ts = event.timestamp ?? Date.now();

      // Host-sensing observer event: full parity with the removed brain-local
      // ObserverService — vault observation + classify (under the real observer
      // type so the rules fire) → reactor/coalescer + republish onto the
      // `observer.*` workflow bus.
      const observerType = sidecarObserverTypeMap[event.event_type];
      if (observerType) {
        const observerEvt = { type: observerType, data: payloadObj, timestamp: ts };

        try {
          createObservation(mapEventType(observerType), payloadObj);
        } catch (err) {
          console.error('[Daemon] Observer vault write failed:', err instanceof Error ? err.message : err);
        }

        try {
          const classified = classifyEvent(observerEvt);
          if (classified.priority === 'critical' || classified.priority === 'high') {
            reactor.react(classified).catch(err =>
              console.error('[Daemon] Observer reactor error:', err)
            );
          } else {
            coalescer.addEvent(classified);
          }
        } catch (err) {
          console.error('[Daemon] Observer classify failed:', err instanceof Error ? err.message : err);
        }

        const mapped = OBSERVER_EVENT_TYPE_MAP[observerType];
        const canonical = mapped ?? `observer.${observerType}`;
        if (!mapped && !observerWarnedTypes.has(observerType)) {
          observerWarnedTypes.add(observerType);
          console.warn(
            `[Daemon] Sidecar observer "${observerType}" not in OBSERVER_EVENT_TYPE_MAP; publishing as "${canonical}". Add a mapping in src/workflows/runtime/event-types.ts.`,
          );
        }
        try {
          sharedEventBus.publish(canonical, { ...payloadObj, _timestamp: ts });
        } catch (err) {
          console.error('[Daemon] Observer bus publish failed:', err instanceof Error ? err.message : err);
        }

        // Keep the dashboard broadcast (parity with prior sidecar event handling).
        wsService.broadcastSidecarEvent(sidecarId, {
          type: `sidecar_${event.event_type}`,
          data: { sidecar_id: sidecarId, ...payloadObj },
          timestamp: ts,
        });
        return;
      }

      // Any other sidecar event: generic classify + dashboard broadcast.
      const eventType = `sidecar_${event.event_type}`;
      const eventData = { sidecar_id: sidecarId, ...payloadObj };
      const observerEvent = { type: eventType, data: eventData, timestamp: ts };

      const classified = classifyEvent(observerEvent);
      if (classified.priority === 'critical' || classified.priority === 'high') {
        reactor.react(classified).catch(err =>
          console.error('[Daemon] Sidecar event reaction error:', err)
        );
      } else {
        coalescer.addEvent(classified);
      }

      wsService.broadcastSidecarEvent(sidecarId, observerEvent);
    });

    // 11. Start health monitoring
    healthMonitor.start(config.healthCheckInterval);

    // 12. The 15-min heartbeat that called bgAgent.handleHeartbeat() has been
    // deleted. It was the single largest idle LLM cost in the daemon. What
    // changed for each thing the heartbeat used to do:
    //   - commitment.overdue / commitment.due_soon workflow events:
    //       now emitted by CommitmentExecutor on state transitions (one-shot
    //       per id rather than every 15 min). Better semantics for on_event
    //       triggers; no behavior change for any current subscriber.
    //   - EventReactor.react() calls on each commitment event (LLM):
    //       REMOVED. CommitmentExecutor fires its own MANDATORY execution
    //       prompt when the cancel deadline elapses, which is the same LLM
    //       work without the duplicate "react" step the heartbeat added.
    //   - Coalesced low-priority events flushed to the LLM:
    //       REMOVED. Observer events still route through the reactor at the
    //       moment they're classified critical/high; low-priority events no
    //       longer get a periodic summary digest. EventReactor's per-event
    //       handling for observer events (file/clipboard/process/etc.)
    //       continues to work because those paths never went through the
    //       heartbeat - they were already event-driven.
    //   - Generic "review your responsibilities" LLM prompt:
    //       REMOVED. Phase 4 will reintroduce purposeful background work via
    //       the conversation-tier orchestrator if it proves needed.
    //
    // `heartbeatConfig.aggressiveness` is still read by CommitmentExecutor.
    // `heartbeatConfig.interval_minutes` and `active_hours` are now ignored.

    logWithTimestamp(`JARVIS daemon running on port ${config.port}`);
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('');

    // Print initial health status
    console.log(healthMonitor.formatHealth());
    console.log('');

  } catch (error) {
    console.error('[Daemon] Fatal error during startup:', error);
    process.exit(1);
  }
}

// Register signal handlers
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// SIGHUP = reload settings from the DB (daemon convention). Covers settings
// edited outside the daemon process (sqlite3 CLI, hosted control plane);
// same path as POST /api/config/reload. Registering the handler also stops
// the default terminate-on-HUP, which is what we want for a daemon.
if (process.platform !== 'win32') {
  process.on('SIGHUP', () => {
    if (!settingsReload) {
      console.log('[Daemon] SIGHUP received before boot finished — ignoring');
      return;
    }
    console.log('[Daemon] SIGHUP — reloading settings from DB');
    settingsReload.reloadAll()
      .then((r) => {
        const changed = r.changed.length > 0 ? r.changed.join(', ') : 'nothing';
        console.log(`[Daemon] SIGHUP reload done — changed: ${changed}${r.errors.length ? `, errors: ${r.errors.length}` : ''}`);
        // The pebble realtime re-advertisement runs inside reloadAll's
        // post-reload hook, shared with POST /api/config/reload.
      })
      .catch((err) => console.error('[Daemon] SIGHUP reload failed:', err));
  });
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Daemon] Uncaught exception:', error);
  handleShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);

  // Browser timeouts and CDP errors should NOT crash the daemon
  if (msg.includes('Timeout waiting for') || msg.includes('CDP')) {
    console.warn('[Daemon] Non-fatal browser error (ignoring):', msg);
    return;
  }

  console.error('[Daemon] Unhandled rejection:', reason);
  handleShutdown('unhandledRejection');
});

// Run as CLI if executed directly
if (import.meta.main) {
  const args = parseArgs();
  await startDaemon(args);
}
