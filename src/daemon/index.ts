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
import { AgentService } from "./agent-service.ts";
import { ObserverService } from "./observer-service.ts";
import { WebSocketService } from "./ws-service.ts";
import { EventReactor } from "./event-reactor.ts";
import { EventCoalescer } from "./event-coalescer.ts";
import { CommitmentExecutor } from "./commitment-executor.ts";
import { checkCommitments, classifyEvent } from "./event-classifier.ts";
import { createApiRoutes } from "./api-routes.ts";
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
let heartbeatTimer: Timer | null = null;
let commitmentExecutor: CommitmentExecutor | null = null;
let bgAgent: BackgroundAgentService | null = null;
let awarenessService: import('../awareness/service.ts').AwarenessService | null = null;
let goalService: import('../goals/service.ts').GoalService | null = null;

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
        (config as any).noLocalTools = true;
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
    // Clear heartbeat timer
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
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

    // Close database
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
  const jarvisConfig = await loadConfig();

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
  };

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

    // 2b. Load LLM settings from DB + encrypted keychain, merge into config
    const { mergeLLMSettingsIntoConfig } = await import('./llm-settings.ts');
    mergeLLMSettingsIntoConfig(jarvisConfig);
    logWithTimestamp('LLM settings loaded from database');

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
    const observerService = new ObserverService(reactor, coalescer, googleAuth ?? undefined);
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

    // 6c. Create sidecar manager
    const sidecarManager = new SidecarManager(jarvisConfig.daemon.data_dir.replace('~', os.homedir()));
    const brainDomain = jarvisConfig.daemon.brain_domain ?? `localhost:${config.port}`;
    sidecarManager.setBrainUrl(brainDomain);

    // 6d. Wire sidecar manager to WebSocket server for WS routing
    wsService.getServer().setSidecarManager(sidecarManager);

    // 7. Register services in startup order
    //    Agent first (needs DB), Observers second, Channels third, Sidecar, WebSocket last (needs Agent)
    registry.register(agentService);
    registry.register(observerService);
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
    const apiRoutes = createApiRoutes(apiContext);
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
    }
    approvalDelivery.setBroadcaster(wsService);
    approvalDelivery.setChannelSender(channelService);
    deferredExecutor.setResultCallback((requestId, request, result) => {
      // Notify via WS and channels that an approved action was executed
      const text = `[EXECUTED] ${request.tool_name}: ${result.slice(0, 200)}`;
      wsService.broadcastNotification(text, 'normal');
    });

    // 10b. Create and start background agent (needs LLM providers from agentService.start())
    const bgAgentService = new BackgroundAgentService(jarvisConfig, agentService.getLLMManager());
    bgAgentService.setResearchQueue(researchQueue);
    await bgAgentService.start();
    bgAgent = bgAgentService;
    console.log('[Daemon] Background agent started (separate browser for heartbeat/reactions)');

    // 10c. Wire reactor + executor to background agent (separate browser, no chat contention)
    reactor.setAgentService(bgAgentService);
    executor.setAgentService(bgAgentService);

    // 10d. Wire executor broadcast (needs wsServer running) and start
    executor.setBroadcast((msg) => wsService.getServer().broadcast(msg));
    wsService.setCommitmentExecutor(executor);
    executor.start();
    commitmentExecutor = executor;

    // 10e. Create and start Awareness Service (M13)
    if (jarvisConfig.awareness?.enabled !== false) {
      try {
        const { AwarenessService } = await import('../awareness/service.ts');
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
          googleAuth
        );
        await svc.start();
        awarenessService = svc;
        apiContext.awarenessService = svc;
        console.log('[Daemon] Awareness service started (event-driven OCR + context tracking)');

        // Wire sidecar awareness events to awareness service
        sidecarManager.onEvent((sidecarId, event) => {
          if (['screen_capture', 'context_changed', 'idle_detected'].includes(event.event_type)) {
            svc.handleSidecarEvent(sidecarId, event);
          }
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
    }

    // 10b. Workflow Automation Engine (M14)
    const workflowConfig = jarvisConfig.workflows;
    if (workflowConfig?.enabled !== false) {
      try {
        const { NodeRegistry } = await import('../workflows/nodes/registry.ts');
        const { registerBuiltinNodes } = await import('../workflows/nodes/builtin.ts');
        const { WorkflowEngine } = await import('../workflows/engine.ts');
        const { TriggerManager } = await import('../workflows/triggers/manager.ts');
        const { NLWorkflowBuilder } = await import('../workflows/nl-builder.ts');
        const { WorkflowAutoSuggest } = await import('../workflows/auto-suggest.ts');

        // Create node registry and register all built-in nodes
        const nodeRegistry = new NodeRegistry();
        registerBuiltinNodes(nodeRegistry);
        console.log(`[Daemon] Node registry: ${nodeRegistry.count()} nodes registered`);

        // Create and start workflow engine
        const wfToolRegistry = orchestrator.getToolRegistry();
        const workflowEngine = new WorkflowEngine(
          nodeRegistry,
          wfToolRegistry ?? new (await import('../actions/tools/registry.ts')).ToolRegistry(),
          agentService.getLLMManager(),
        );
        workflowEngine.setEventCallback((event) => {
          wsService.broadcastWorkflowEvent(event);
        });
        await workflowEngine.start();

        // Create and start trigger manager
        const triggerManager = new TriggerManager(workflowEngine);
        await triggerManager.start();

        // Create NL builder and auto-suggest
        const nlBuilder = new NLWorkflowBuilder(nodeRegistry, agentService.getLLMManager());
        const autoSuggest = new WorkflowAutoSuggest(nodeRegistry, agentService.getLLMManager());

        // Wire awareness events into auto-suggest
        if (awarenessService) {
          // The awareness service emits events that can feed pattern detection
          console.log('[Daemon] Workflow auto-suggest wired to awareness events');
        }

        // Register manage_workflow tool so primary agent can create/run workflows from chat
        const { createManageWorkflowTool } = await import('../actions/tools/workflows.ts');
        const manageWorkflowTool = createManageWorkflowTool({ workflowEngine, nlBuilder, triggerManager });
        if (wfToolRegistry) {
          wfToolRegistry.register(manageWorkflowTool);
          console.log('[Daemon] manage_workflow tool registered for chat agent');
        }

        // Wire into API context
        (apiContext as any).workflowEngine = workflowEngine;
        (apiContext as any).triggerManager = triggerManager;
        (apiContext as any).webhookManager = triggerManager.getWebhookManager();
        (apiContext as any).nodeRegistry = nodeRegistry;
        (apiContext as any).nlBuilder = nlBuilder;
        (apiContext as any).autoSuggest = autoSuggest;

        console.log('[Daemon] Workflow engine started (engine + triggers + NL builder + auto-suggest)');
      } catch (err) {
        console.error('[Daemon] Workflow engine failed to start:', err instanceof Error ? err.message : err);
        // Non-fatal — daemon continues without workflows
      }
    }

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
        });
        goalSvc.setEventCallback((event) => {
          wsService.broadcastGoalEvent(event);
        });
        await goalSvc.start();
        goalService = goalSvc;
        apiContext.goalService = goalSvc;

        // Wire workflow bridge for daily rhythm
        try {
          const { generateRhythmWorkflows, registerGoalWorkflows } = await import('../goals/workflow-bridge.ts');
          const effectiveConfig = goalsConfig ?? {
            enabled: true,
            morning_window: { start: 7, end: 9 },
            evening_window: { start: 20, end: 22 },
            accountability_style: 'drill_sergeant' as const,
            escalation_weeks: { pressure: 1, root_cause: 3, suggest_kill: 4 },
            auto_decompose: true,
            calendar_ownership: false,
          };
          const rhythmWorkflows = generateRhythmWorkflows(effectiveConfig);
          if (apiContext.triggerManager) {
            registerGoalWorkflows(rhythmWorkflows, apiContext.triggerManager as any);
          }
        } catch { /* workflow bridge is optional */ }

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

    // 10h. Wire sidecar events into event pipeline
    sidecarManager.onEvent((sidecarId, event) => {
      const eventType = `sidecar_${event.type}`;
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

    // 12. Set up heartbeat timer with configurable interval and active hours
    const heartbeatIntervalMs = (heartbeatConfig?.interval_minutes ?? 15) * 60 * 1000;
    const activeHours = heartbeatConfig?.active_hours ?? { start: 8, end: 23 };

    console.log(`[Daemon] Heartbeat interval: ${heartbeatConfig?.interval_minutes ?? 15} min, active hours: ${activeHours.start}:00-${activeHours.end}:00`);

    let heartbeatBusy = false;
    heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy) return;
      // Check if within active hours
      const currentHour = new Date().getHours();
      if (currentHour < activeHours.start || currentHour >= activeHours.end) {
        console.log(`[Daemon] Outside active hours (${activeHours.start}-${activeHours.end}), skipping heartbeat`);
        return;
      }

      heartbeatBusy = true;
      try {
        // Check commitments and route critical/high ones to reactor
        const commitmentEvents = checkCommitments();
        for (const evt of commitmentEvents) {
          if (evt.priority === 'critical' || evt.priority === 'high') {
            reactor.react(evt).catch(err =>
              console.error('[Daemon] Commitment reaction error:', err)
            );
          } else {
            coalescer.addEvent(evt);
          }
        }

        // Flush coalesced events for heartbeat
        const coalescedSummary = coalescer.flush();

        // Run heartbeat on BACKGROUND agent (separate browser, doesn't block chat)
        const heartbeatResponse = await bgAgentService.handleHeartbeat(
          coalescedSummary || undefined
        );

        if (heartbeatResponse) {
          console.log('[Daemon] Heartbeat response:', heartbeatResponse.slice(0, 100));
          wsService.broadcastHeartbeat(heartbeatResponse);
        }
      } catch (err) {
        console.error('[Daemon] Heartbeat error:', err);
      } finally {
        heartbeatBusy = false;
      }
    }, heartbeatIntervalMs);

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
