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
import { ServiceRegistry } from "./services.ts";
import { HealthMonitor } from "./health.ts";
import { loadConfig } from "../config/loader.ts";
import { writeLockedPort } from "./pid.ts";
import { AgentService } from "./agent-service.ts";
import { ObserverService } from "./observer-service.ts";
import { WebSocketService } from "./ws-service.ts";
import { EventReactor } from "./event-reactor.ts";
import { EventCoalescer } from "./event-coalescer.ts";
import { CommitmentExecutor } from "./commitment-executor.ts";
import { classifyEvent } from "./event-classifier.ts";
import { createApiRoutes, setCorsOrigin } from "./api-routes.ts";
import { GoogleAuth } from "../integrations/google-auth.ts";
import { ResearchQueue } from "./research-queue.ts";
import { researchQueueTool, setResearchQueueRef } from "../actions/tools/research.ts";
import { ChannelService } from "./channel-service.ts";
import { BackgroundAgentService } from "./background-agent-service.ts";
import { AuthorityEngine } from "../authority/engine.ts";
import { ApprovalManager } from "../authority/approval.ts";
import { AuditTrail } from "../authority/audit.ts";
import { AuthorityLearner } from "../authority/learning.ts";
import { EmergencyController } from "../authority/emergency.ts";
import { ApprovalDelivery } from "../authority/approval-delivery.ts";
import { DeferredExecutor } from "../authority/deferred-executor.ts";
import { sendDesktopNotification } from "../comms/desktop-notify.ts";
import { SidecarManager } from "../sidecar/manager.ts";
import { ensureWorkflowSchema } from "../workflows/db/index.ts";
import { Worker as WorkflowWorker } from "../workflows/queue/worker.ts";
import { createRunFlowHandler, RUN_FLOW } from "../workflows/runner/handler.ts";
import { createWorkflowRoutes } from "../workflows/api/routes.ts";
import { TriggerManager } from "../workflows/runner/triggers/manager.ts";
import { AWARENESS_EVENT_TYPE_MAP, OBSERVER_EVENT_TYPE_MAP } from "../workflows/runtime/event-types.ts";
import { WorkflowEventBus } from "../workflows/runtime/event-bus.ts";
import { WorkflowEventBuffer } from "../workflows/runtime/event-buffer.ts";
import {
  bootstrapWorkflowEngine,
  type BootstrapWorkflowEngineResult,
} from "../workflows/runtime/engine-bootstrap.ts";
import { CredentialResolver } from "../workflows/credentials/adapter.ts";
import { metadataToCatalogEntry } from "../workflows/runtime/piece-catalog.ts";
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
    console.log('\n[Daemon] Force shutdown requested, exiting immediately');
    process.exit(1);
  }

  shutdownInProgress = true;
  console.log(`\n[Daemon] Received ${signal}, shutting down gracefully...`);

  try {
    // Stop system cron (publishes cron.* events on the shared bus)
    if (systemCron) {
      systemCron.stop();
      systemCron = null;
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

    // Stop health monitor
    if (healthMonitor) {
      healthMonitor.stop();
    }

    // Stop all services (reverse order: websocket -> observers -> agent)
    if (registry) {
      await registry.stopAll();
    }

    // Stop the trigger manager first so no new RUN_FLOW jobs get enqueued
    // while the worker drains.
    if (triggerManager) {
      await triggerManager.stop();
      triggerManager = null;
    }

    // Stop the workflow worker (drains in-flight jobs, then exits the poll loop)
    if (workflowWorker) {
      await workflowWorker.stop();
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

  // Record the actual bound port in the lockfile so `jarvis stop` knows which
  // port to verify even when the daemon was started with --port, JARVIS_PORT,
  // or a mid-run config change. No-op if we don't hold the lock (e.g. tests).
  writeLockedPort(port);

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

    // 2b. Load LLM settings from DB + encrypted keychain, merge into config
    const { mergeLLMSettingsIntoConfig } = await import('./llm-settings.ts');
    mergeLLMSettingsIntoConfig(jarvisConfig);
    logWithTimestamp('LLM settings loaded from database');

    // 2c. Derive llm.tiers from legacy primary if user hasn't configured tiers.
    // Run AFTER mergeLLMSettingsIntoConfig so DB-stored primary overrides the
    // YAML primary before we derive the medium tier.
    const { migrateLegacyLLMConfig } = await import('../config/loader.ts');
    migrateLegacyLLMConfig(jarvisConfig);

    // 3. Create service registry
    registry = new ServiceRegistry();

    // 4. Create proactive modules
    const heartbeatConfig = jarvisConfig.heartbeat;
    const reactor = new EventReactor();
    const coalescer = new EventCoalescer();

    // 4b. Create GoogleAuth if configured
    let googleAuth: GoogleAuth | null = null;
    if (jarvisConfig.google?.client_id && jarvisConfig.google?.client_secret) {
      googleAuth = new GoogleAuth(jarvisConfig.google.client_id, jarvisConfig.google.client_secret);
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
    const wsService = new WebSocketService(config.port, agentService);

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
    // Brain URL precedence: env > config.yaml > default fallback. The loader
    // already collapses env into config.daemon.brain_domain, so we re-check
    // the env var here only to attribute the source in the startup log —
    // the operator needs to see which knob is active when debugging.
    const brainSource: 'env' | 'config' | 'default' = process.env.JARVIS_BRAIN_DOMAIN
      ? 'env'
      : jarvisConfig.daemon.brain_domain
        ? 'config'
        : 'default';
    const brainDomain = jarvisConfig.daemon.brain_domain ?? `localhost:${config.port}`;
    sidecarManager.setBrainUrl(brainDomain, brainSource);

    // 6d. Wire sidecar manager to WebSocket server for WS routing
    wsService.getServer().setSidecarManager(sidecarManager);

    // 7. Register services in startup order
    //    Agent first (needs DB), Observers second, Channels third, Sidecar, WebSocket last (needs Agent)
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
      const ttsProvider = createTTSProvider(jarvisConfig.tts);
      if (ttsProvider) {
        wsService.setTTSProvider(ttsProvider);
        console.log(`[Daemon] TTS enabled: ${jarvisConfig.tts.voice ?? 'en-US-AriaNeural'}`);
      }
    }

    // 8d. Wire STT provider for voice input via dashboard
    if (jarvisConfig.stt) {
      const { createSTTProvider } = await import('../comms/voice.ts');
      const sttProvider = createSTTProvider(jarvisConfig.stt);
      if (sttProvider) {
        wsService.setSTTProvider(sttProvider);
        console.log(`[Daemon] STT for voice input: ${jarvisConfig.stt.provider}`);
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
    // Phase 6.3.5b — let WS service resolve approvals from voice intents.
    wsService.setApprovalManager(approvalManager);
    wsService.setDeferredExecutor(deferredExecutor);
    // Voice-channel audit tagging for forensic separation from click path.
    wsService.setAuditTrail(auditTrail);

    // Restore emergency state from config
    const savedEmergencyState = authorityConfig.emergency_state ?? 'normal';
    if (savedEmergencyState === 'paused') emergencyController.pause();
    else if (savedEmergencyState === 'killed') emergencyController.kill();

    // Persist emergency state changes to config.yaml
    emergencyController.setStateChangeCallback(async (state) => {
      wsService.broadcastEmergencyState(state);
      try {
        const { loadConfig: reloadConfig, saveConfig: resaveConfig } = await import('../config/loader.ts');
        const fresh = await reloadConfig();
        if (!fresh.authority) fresh.authority = { default_level: 3 } as any;
        fresh.authority.emergency_state = state;
        await resaveConfig(fresh);
      } catch (err) {
        console.error('[Daemon] Failed to persist emergency state:', err);
      }
    });

    // Wire authority engine into orchestrator
    const orchestrator = agentService.getOrchestrator();
    orchestrator.setAuthorityEngine(authorityEngine);
    orchestrator.setApprovalManager(approvalManager);
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

      if (action === 'approve') {
        const approved = approvalManager.approve(request.id, channel);
        if (!approved) return 'Request already decided';
        const result = await deferredExecutor.executeApproved(request.id);
        const updated = approvalManager.getRequest(request.id);
        if (updated) wsService.broadcastApprovalUpdate(updated);
        return `Approved and executed. Result: ${result.slice(0, 200)}`;
      } else {
        const denied = approvalManager.deny(request.id, channel);
        if (!denied) return 'Request already decided';
        deferredExecutor.recordDenial(denied);
        wsService.broadcastApprovalUpdate(denied);
        return `Denied: ${request.tool_name}`;
      }
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
    };
    setCorsOrigin(jarvisConfig.daemon.port);

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
    if (googleAuth) {
      const { JarvisGoogleConnectionSource } = await import(
        "../workflows/credentials/google-source.ts"
      );
      credentialResolver.register(new JarvisGoogleConnectionSource(googleAuth));
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

    // 9c. Configure auth token if set
    const authToken = jarvisConfig.auth?.token;
    if (authToken) {
      wsService.setAuthToken(authToken);
      console.log('[Daemon] Auth token configured — dashboard routes require ?token= or cookie');
    } else {
      console.warn('[Daemon] No auth token configured — dashboard is open to anyone on the network');
    }

    // 9b. Apply --no-local-tools flag if set
    if (config.noLocalTools) {
      const { setNoLocalTools } = await import('../actions/tools/builtin.ts');
      setNoLocalTools(true);
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
          // A realistic flow is 500-2000 output tokens; we ask for 4096
          // to leave room for verbose pieces (long input schemas, many
          // steps) without surprise truncation. Ollama's default
          // `num_predict` is 128 -- truncates every compose reply mid-
          // JSON and crashes parsing with "Unexpected EOF". Other
          // providers either have higher defaults or ignore the cap.
          const reply = await llmManager.chat(messages, { max_tokens: 4096 });
          // `LLMResponse.content` is the assistant-text field; an earlier
          // version of this adapter read `reply.text` which doesn't
          // exist on the provider response shape, so every compose
          // returned "" and JSON.parse crashed with EOF. Stay strict
          // here -- if the provider ever returns ContentBlock[] for
          // text-only completions we want to know.
          const content = typeof reply.content === "string" ? reply.content : "";
          return { text: content };
        },
      };
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
      });
      if (!toolRegistry.has('manage_workflow')) {
        toolRegistry.register(manageWorkflowTool);
        console.log('[Daemon] Registered manage_workflow tool');
      }
    }
    approvalDelivery.setBroadcaster(wsService);
    approvalDelivery.setChannelSender(channelService);
    deferredExecutor.setResultCallback((requestId, request, result) => {
      // Notify via WS and channels that an approved action was executed.
      // Skip for intent-only approvals — they have no deferred execution.
      if (request.tool_name === 'request_approval') return;
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
          agentService.buildFullSystemPrompt("workflow", userMessage),
      });
      workflowSandboxApi.setServices(backends);
      logWithTimestamp("Workflow engine service backends wired (llm/tools/notify/context/agent/events/workflows)");

      const flowExecutor = new EngineFlowExecutor(workflowEngineRuntime);
      workflowWorker = new WorkflowWorker({
        handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: flowExecutor }) },
      });
      workflowWorker.start();
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
          googleAuth,
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

        // Auto-launch overlay widget (non-blocking, best-effort)
        if (jarvisConfig.awareness?.overlay_autolaunch !== false) {
          try {
            const overlayUrl = `http://localhost:${config.port}/overlay`;
            const browsers = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'];
            for (const browser of browsers) {
              const which = Bun.spawnSync(['which', browser]);
              if (which.exitCode === 0) {
                Bun.spawn([
                  browser,
                  `--app=${overlayUrl}`,
                  '--window-size=300,320',
                  '--window-position=20,20',
                  '--no-sandbox',
                  '--disable-extensions',
                  '--disable-gpu',
                  `--user-data-dir=${path.join(config.dataDir, 'browser', 'overlay-profile')}`,
                ], { stdout: 'ignore', stderr: 'ignore' });
                console.log(`[Daemon] Awareness overlay launched (${browser})`);
                break;
              }
            }
          } catch (err) { console.warn('[Daemon] Awareness overlay failed (non-fatal):', err instanceof Error ? err.message : err); }
        }
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

    // 10h. Wire sidecar events into event pipeline (skip awareness events — already handled by awareness service)
    const awarenessEventTypes = ['screen_capture', 'context_changed', 'idle_detected'];
    sidecarManager.onEvent((sidecarId, event) => {
      // Skip events already routed to awareness service to avoid double processing
      if (awarenessService && awarenessEventTypes.includes(event.event_type)) return;

      const eventType = `sidecar_${event.event_type}`;
      const eventData = {
        sidecar_id: sidecarId,
        ...(typeof event.payload === 'object' && event.payload !== null ? event.payload as Record<string, unknown> : { payload: event.payload }),
      };
      const observerEvent = {
        type: eventType,
        data: eventData,
        timestamp: event.timestamp ?? Date.now(),
      };

      // Classify and route
      const classified = classifyEvent(observerEvent);
      if (classified.priority === 'critical' || classified.priority === 'high') {
        reactor.react(classified).catch(err =>
          console.error('[Daemon] Sidecar event reaction error:', err)
        );
      } else {
        coalescer.addEvent(classified);
      }

      // Broadcast to dashboard
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
