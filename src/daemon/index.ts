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
import { checkCommitments, classifyEvent } from "./event-classifier.ts";
import { createApiRoutes, setCorsOrigin } from "./api-routes.ts";
import { GoogleAuth } from "../integrations/google-auth.ts";
import { ResearchQueue } from "./research-queue.ts";
import { researchQueueTool, setResearchQueueRef } from "../actions/tools/research.ts";
import { spawnPersistentAgent, assignPersistentAgentTask } from "../actions/tools/agents.ts";
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

    // 2a. Seed webapp templates (upserts, safe to run every startup)
    const { seedWebappTemplates } = await import('../vault/webapp-template-seeds.ts');
    seedWebappTemplates();

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
    if (process.env.JARVIS_AMBIENT_UI === '1') {
      const spawnedOn = new Set<string>();

      // Per-sidecar in-flight summon control. Tracks whether a summon is
      // active and lets us cancel mid-flight when the user dismisses with
      // a second hotkey press.
      const pendingSummons = new Map<string, { cancelled: boolean }>();

      // setState pairs the visual state with optional bubble body text. The
      // text wins over the per-state placeholder ("speaking…", "listening —
      // go ahead.") so we can surface the live LLM response instead of the
      // generic copy. Empty/undefined text falls back to the placeholder.
      const setState = async (sidecarId: string, state: string, text?: string) => {
        try {
          const params: { state: string; text?: string } = { state };
          if (text !== undefined) params.text = text;
          await sidecarManager.dispatchRPC(sidecarId, 'pebble.set_state', params);
        } catch (err) {
          console.warn(`[ambient-ui] pebble.set_state(${state}) on ${sidecarId} failed:`, err);
        }
      };

      // STT + TTS providers for the pebble's voice loop. Both built from
      // the same jarvisConfig.* the dashboard uses so API keys / provider
      // choice (OpenAI Whisper / Groq / Local / Sarvam for STT;
      // edge-tts / ElevenLabs / Sarvam for TTS) carry over.
      let pebbleSTT: import('../comms/voice.ts').STTProvider | null = null;
      let pebbleTTS: import('../comms/voice.ts').TTSProvider | null = null;
      if (jarvisConfig.stt) {
        try {
          const { createSTTProvider } = await import('../comms/voice.ts');
          pebbleSTT = createSTTProvider(jarvisConfig.stt);
          if (pebbleSTT) {
            console.log(`[ambient-ui] STT provider for pebble: ${jarvisConfig.stt.provider}`);
          }
        } catch (err) {
          console.warn('[ambient-ui] failed to init STT provider:', err);
        }
      }
      if (jarvisConfig.tts?.enabled) {
        try {
          const { createTTSProvider } = await import('../comms/voice.ts');
          pebbleTTS = createTTSProvider(jarvisConfig.tts);
          if (pebbleTTS) {
            console.log(`[ambient-ui] TTS provider for pebble: ${jarvisConfig.tts.provider ?? 'edge-tts'}`);
          }
        } catch (err) {
          console.warn('[ambient-ui] failed to init TTS provider:', err);
        }
      }

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

      sidecarManager.onSidecarConnected(async (sidecar) => {
        if (!sidecar.capabilities.includes('pebble')) {
          console.log(`[ambient-ui] Sidecar ${sidecar.id} lacks 'pebble' capability — skipping native pebble spawn`);
          return;
        }
        if (spawnedOn.has(sidecar.id)) return;
        spawnedOn.add(sidecar.id);
        try {
          const result = await sidecarManager.dispatchRPC(sidecar.id, 'pebble.spawn', {
            cursor_offset_x: 22,
            cursor_offset_y: 26,
            summon_hotkey: 'ctrl+space',
            palette_hotkey: 'ctrl+k',
          });
          console.log(`[ambient-ui] Native pebble spawned on ${sidecar.id}:`, result);
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
          const sidecarIds = subPebbleCapableSidecars();
          if (sidecarIds.length === 0) {
            console.log(`[sub-pebble] ${event} task=${task.id} — no sub_pebble-capable sidecars connected, skipping`);
            return;
          }
          for (const sidecarId of sidecarIds) {
            try {
              if (event === 'launch') {
                const slot = nextSlot(sidecarId);
                let used = subPebbleSlots.get(sidecarId);
                if (!used) { used = new Map(); subPebbleSlots.set(sidecarId, used); }
                used.set(task.id, slot);
                await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.spawn', {
                  id: task.id,
                  color: colorForTask(task.id),
                  slot,
                  label: task.agentName,
                  state: 'working',
                });
                console.log(`[sub-pebble] spawn task=${task.id} agent=${task.agentName} slot=${slot}`);
              } else if (event === 'complete' || event === 'fail') {
                const state = event === 'complete' ? 'idle' : 'idle'; // both end states render solid; failed uses vermilion via initial color override below
                if (event === 'fail') {
                  // Force vermilion + the new state — recolor by re-spawning
                  // (sub-pebble Spawn is idempotent so this would no-op).
                  // Cleaner option: a sub_pebble.set_color RPC. For Phase A
                  // we just flip state; the original color stays. The user
                  // can tell completed vs failed from the agent strip room.
                  await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.set_state', {
                    id: task.id, state,
                  });
                } else {
                  await sidecarManager.dispatchRPC(sidecarId, 'sub_pebble.set_state', {
                    id: task.id, state,
                  });
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
        pendingSummons.set(sidecarId, { cancelled: false });
        setState(sidecarId, 'listening', '');
        console.log(`[ambient-ui] pebble.summon on ${sidecarId} — listening for audio…`);
      });

      // W2-T22 + T23: audio session arrives → STT → LLM → speaking → idle.
      // The pebble's state transitions are now driven by the actual audio
      // pipeline (capture done → transcribe → think → speak), not timers.
      const audioSessions = new (await import('./audio-sessions.ts')).AudioSessionRegistry();
      audioSessions.attach((cb) => sidecarManager.onEvent(cb));
      // T20 — voice-driven settings mutation. Patches `jarvisConfig`,
      // persists via `saveConfig`, and rebuilds the live providers so
      // the next response uses the new setting without a daemon
      // restart. The user explicitly hit this with "turn off TTS in
      // the settings" — the panel opened but the toggle didn't flip
      // because no handler was wired to the request. This closes that
      // gap. New providers added to `jarvisConfig` (e.g. Groq STT)
      // become voice-switchable too.
      const applyTTSEnabled = async (enabled: boolean): Promise<void> => {
        const { loadConfig, saveConfig } = await import('../config/loader.ts');
        const fresh = await loadConfig();
        if (!fresh.tts) fresh.tts = { enabled, provider: 'edge' };
        else fresh.tts.enabled = enabled;
        await saveConfig(fresh);
        jarvisConfig.tts = fresh.tts;
        // Rebuild the pebble's TTS provider so the next response cycle
        // either uses the new provider or skips TTS entirely.
        if (enabled) {
          try {
            const { createTTSProvider } = await import('../comms/voice.ts');
            pebbleTTS = createTTSProvider(fresh.tts);
            if (pebbleTTS) console.log('[ambient-ui] TTS re-enabled via voice command');
          } catch (err) {
            console.warn('[ambient-ui] failed to re-init TTS provider:', err);
            pebbleTTS = null;
          }
        } else {
          pebbleTTS = null;
          console.log('[ambient-ui] TTS disabled via voice command');
        }
        // Hot-reload dashboard TTS too so the WSService stays in sync.
        if (wsService && fresh.tts) {
          try {
            const { createTTSProvider } = await import('../comms/voice.ts');
            const provider = createTTSProvider(fresh.tts);
            if (provider && enabled) wsService.setTTSProvider(provider);
          } catch { /* dashboard fallback */ }
        }
      };

      const applySTTProvider = async (provider: 'openai' | 'groq' | 'sarvam' | 'local'): Promise<boolean> => {
        const { loadConfig, saveConfig } = await import('../config/loader.ts');
        const fresh = await loadConfig();
        if (!fresh.stt) fresh.stt = { provider };
        // Refuse the switch if the target provider has no API key
        // configured — we don't want to silently break STT.
        const hasKey = (() => {
          if (provider === 'local') return !!fresh.stt.local?.endpoint;
          const sub = (fresh.stt as unknown as Record<string, { api_key?: string } | undefined>)[provider];
          return !!sub?.api_key;
        })();
        if (!hasKey) return false;
        fresh.stt.provider = provider;
        await saveConfig(fresh);
        jarvisConfig.stt = fresh.stt;
        try {
          const { createSTTProvider } = await import('../comms/voice.ts');
          pebbleSTT = createSTTProvider(fresh.stt);
          console.log(`[ambient-ui] STT provider switched to ${provider} via voice command`);
        } catch (err) {
          console.warn('[ambient-ui] failed to re-init STT provider:', err);
        }
        return true;
      };

      // T19 — region selection ("help with this"). Tracks the
      // original transcript while the sidecar overlay runs so the
      // LLM gets the user's question paired with the captured image.
      const pendingRegionByPebble = new Map<string, { userText: string; ctrl: { cancelled: boolean }; startedAt: number }>();

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
          await applyTTSEnabled(false);
          // Speak the confirmation BEFORE shutting TTS down — temp
          // restore a one-shot provider so the user hears acknowledgment.
          await speakConfirmation(sidecarId, "Text-to-speech turned off.", ctrl);
          return true;
        }
        if (ttsOn) {
          await applyTTSEnabled(true);
          await speakConfirmation(sidecarId, "Text-to-speech turned on.", ctrl);
          return true;
        }

        // STT provider switch.
        const sttMatch =
          /\b(switch|change)\s+(?:the\s+)?(stt|speech[- ]to[- ]text|transcription|speech recognition|listening)\s+(?:to|provider to)\s+(openai|whisper|groq|sarvam|local)\b/.exec(t) ||
          /\buse\s+(openai|whisper|groq|sarvam|local)\s+(?:for\s+(?:stt|speech[- ]to[- ]text|transcription|speech recognition|listening|hearing))\b/.exec(t);
        if (sttMatch) {
          let target = (sttMatch[2] === 'whisper' ? 'openai' : sttMatch[2]) as 'openai' | 'groq' | 'sarvam' | 'local';
          // The first capture group depends on which alternative matched.
          const candidate = (sttMatch[3] || sttMatch[1]) as string;
          if (candidate && /^(openai|whisper|groq|sarvam|local)$/.test(candidate)) {
            target = (candidate === 'whisper' ? 'openai' : candidate) as typeof target;
          }
          const ok = await applySTTProvider(target);
          await speakConfirmation(
            sidecarId,
            ok
              ? `Switched transcription to ${target}.`
              : `I can't switch to ${target} — it doesn't have an API key configured.`,
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
      };

      // Match aliases longest-first so "tool catalog" wins over "tools" when
      // both appear in the input.
      const orderedAliases: { alias: string; key: string }[] = [];
      for (const [key, meta] of Object.entries(ROOMS)) {
        for (const alias of meta.aliases) orderedAliases.push({ alias, key });
      }
      orderedAliases.sort((a, b) => b.alias.length - a.alias.length);

      const dashboardURL = (key: string): string => {
        const port = (jarvisConfig as { daemon?: { port?: number } }).daemon?.port ?? 3142;
        // _panel_<key> renders ONLY the RoomBody inside the spawned native
        // window (no AppShell, no voice handlers) so the pebble's sidecar-
        // side voice loop is the single voice surface — no double voice.
        // Use _room_<key> in the dashboard SPA when the user wants the full
        // takeover with thread + rail context.
        return `http://localhost:${port}/#/_panel_${key}`;
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
      const PALETTE_REOPEN_COOLDOWN_MS = 350;
      const PALETTE_W = 460;
      const PALETTE_H = 440;
      const paletteURL = (): string => {
        const port = (jarvisConfig as { daemon?: { port?: number } }).daemon?.port ?? 3142;
        return `http://localhost:${port}/#/_palette`;
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
      const NEEDS_SCREENSHOT = /\b(where|show me|show where|point (?:to|at)|guide (?:me )?to|find (?:me )?(?:the )?|highlight|locate|tell me where|how (?:do I|to)\s+(?:open|get to|find|see|access|click|reach|use|run|do|start|enable|disable|turn on|turn off))\b/i;
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

      // tryHandleBackgroundIntent — match "in the background, X" /
      // "background: X" / "spawn a background agent to X" and route X
      // through taskManager.launch as a backgrounded sub-agent. The
      // taskManager lifecycle subscription above will spawn the matching
      // sub-pebble on the rail. Skips the LLM entirely — fast path.
      //
      // Specialist pick: defaults to `research_analyst` if present (most
      // general); falls back to the first specialist in the registry.
      // Future smarter routing can pattern-match keywords → specialist id.
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

        // Pick a specialist: prefer research_analyst, fall back to the
        // first registered one so this works on any role catalog.
        let specialistId = 'research_analyst';
        if (!specialists.has(specialistId)) {
          specialistId = Array.from(specialists.keys())[0] ?? '';
        }
        if (!specialistId) {
          await speakConfirmation(sidecarId, "No specialists are configured.", ctrl);
          return true;
        }

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
        if (await tryHandleBackgroundIntent(sidecarId, userText, ctrl)) {
          console.log(`[ambient-ui] background-intent fast path took ${Date.now() - cycleStart}ms`);
          return;
        }
        if (await tryHandlePanelIntent(sidecarId, userText, ctrl)) {
          console.log(`[ambient-ui] panel-intent fast path took ${Date.now() - cycleStart}ms`);
          return;
        }

        await setState(sidecarId, 'thinking', '');

        let firstTokenAt = 0;
        let firstAudioDispatchAt = 0;
        let visibleText = '';
        let unsynth = '';
        let speakingStarted = false;
        let speakingFlipPending: Promise<void> | null = null;
        let lastPlaybackEnd = Date.now();
        let totalAudioMs = 0;
        const pendingTTS: Promise<unknown>[] = [];

        const flipToSpeaking = async () => {
          if (speakingStarted) return;
          speakingStarted = true;
          await setState(sidecarId, 'speaking', '');
        };

        const enqueueSentence = (sentence: string): void => {
          if (!pebbleTTS || !sentence.trim()) return;
          const job = (async () => {
            const ttsStart = Date.now();
            try {
              const audio = await pebbleTTS!.synthesize(sentence);
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
          const onPoint = (rawX: number, rawY: number, label: string) => {
            // Scale image-space coords back to virtual-screen pixels.
            const x = Math.round(rawX * pointScaleX);
            const y = Math.round(rawY * pointScaleY);
            const delay = pointDelayMs;
            pointDelayMs += 4000; // 3.5 s hold + small overlap
            setTimeout(() => {
              sidecarManager.dispatchRPC(sidecarId, 'pebble.point_at', {
                x, y, label, duration_ms: 3500,
              }).catch((err) => {
                console.warn(`[ambient-ui] pebble.point_at(${x},${y}) failed:`, err);
              });
            }, delay);
            const scaledNote = (pointScaleX !== 1 || pointScaleY !== 1)
              ? ` (raw ${rawX},${rawY} × scale ${pointScaleX.toFixed(2)},${pointScaleY.toFixed(2)})`
              : '';
            console.log(`[ambient-ui] point @ (${x},${y}) label="${label}" delay=${delay}ms${scaledNote}`);
          };
          for await (const event of stream) {
            if (ctrl.cancelled) {
              // User dismissed mid-stream. Stop sidecar playback + drain queue.
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
        const remainingMs = Math.max(0, lastPlaybackEnd - Date.now());
        if (remainingMs > 0) {
          await new Promise<void>(r => setTimeout(r, remainingMs));
        }
        if (ctrl.cancelled) return;

        await setState(sidecarId, 'idle', '');
        // Suppress unused-var warning if linting cared.
        void llmDone;
      };

      audioSessions.onComplete(async (session) => {
        const ctrl = pendingSummons.get(session.sidecarId);
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
              console.log(`[ambient-ui] STT (${Date.now() - sttStart}ms): "${transcript}"`);
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
            pendingSummons.delete(session.sidecarId);
            return;
          }
          console.log(`[ambient-ui] user said: "${transcript}"`);

          await runResponseCycle(session.sidecarId, transcript, ctrl);
          pendingSummons.delete(session.sidecarId);
        } catch (err) {
          console.warn('[ambient-ui] voice cycle error:', err);
          await setState(session.sidecarId, 'idle', '');
          pendingSummons.delete(session.sidecarId);
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
        console.log(`[ambient-ui] wake-segment matched (${sttMs}ms STT): "${transcript}"`);

        const command = stripWakePrefix(transcript);
        // Claim the summon slot so the rest of this cycle owns it.
        const ctrl = { cancelled: false };
        pendingSummons.set(sidecarId, ctrl);

        if (!command) {
          // Just "Jarvis" alone — flip to listening and trigger a fresh
          // session capture on the sidecar so the user's next utterance
          // gets transcribed + run through the LLM. The session_end
          // event will land in `audioSessions.onComplete` above, which
          // sees the pendingSummons we just set and runs the response
          // cycle. No need for a separate timeout here — the session
          // capture's own VAD hard-cap bounds the wait.
          await setState(sidecarId, 'listening', '');
          try {
            await sidecarManager.dispatchRPC(sidecarId, 'pebble.start_listening', {});
            console.log(`[ambient-ui] wake → listening (capture started)`);
          } catch (err) {
            console.warn('[ambient-ui] wake → start_listening failed:', err);
            ctrl.cancelled = true;
            pendingSummons.delete(sidecarId);
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
          pendingSummons.delete(sidecarId);
        }
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
            pendingSummons.delete(sidecarId);
          }
          return;
        }
        if (event.event_type !== 'region.captured') return;
        const pending = pendingRegionByPebble.get(sidecarId);
        if (!pending) return;
        pendingRegionByPebble.delete(sidecarId);

        const binary = event.binary as { type?: string; data?: string; mime_type?: string } | undefined;
        if (!binary || binary.type !== 'inline' || typeof binary.data !== 'string') {
          await setState(sidecarId, 'idle', '');
          pendingSummons.delete(sidecarId);
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
          pendingSummons.delete(sidecarId);
          return;
        }

        // Frame the question for the LLM: include the original voice
        // text plus a hint that the image is the user's pointer.
        const promptText = `${userText}\n\n(I've attached a screenshot of the area I selected on screen. Look at the image and answer based on what's shown there.)`;
        try {
          await runResponseCycle(sidecarId, promptText, ctrl, {
            image: { base64: imageBase64, mediaType: mimeType },
          });
        } catch (err) {
          console.warn('[ambient-ui] region voice cycle error:', err);
          await setState(sidecarId, 'idle', '');
        } finally {
          pendingSummons.delete(sidecarId);
        }
      });

      console.log('[ambient-ui] Enabled — native pebble overlay (GDI+/Cocoa/Cairo) will spawn on sidecars with the \'pebble\' capability');
    }

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

    // 12. Set up heartbeat timer with configurable interval and active hours
    const heartbeatIntervalMs = (heartbeatConfig?.interval_minutes ?? 15) * 60 * 1000;
    const activeHours = heartbeatConfig?.active_hours ?? { start: 8, end: 23 };

    console.log(`[Daemon] Heartbeat interval: ${heartbeatConfig?.interval_minutes ?? 15} min, active hours: ${activeHours.start}:00-${activeHours.end}:00`);

    const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minute timeout for heartbeat
    let heartbeatBusy = false;
    heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy) {
        console.log('[Daemon] Skipping heartbeat — previous still running');
        return;
      }
      // Check if within active hours
      const currentHour = new Date().getHours();
      if (currentHour < activeHours.start || currentHour >= activeHours.end) {
        console.log(`[Daemon] Outside active hours (${activeHours.start}-${activeHours.end}), skipping heartbeat`);
        return;
      }

      heartbeatBusy = true;
      console.log('[Daemon] Heartbeat starting...');
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

        // Setup mode = no bgAgent. Skip the heartbeat entirely.
        if (!bgAgent) {
          heartbeatBusy = false;
          return;
        }

        // Run heartbeat on BACKGROUND agent with timeout to prevent stuck busy lock
        const heartbeatPromise = bgAgent.handleHeartbeat(
          coalescedSummary || undefined
        );
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => {
            console.error('[Daemon] Heartbeat timed out after 5 minutes');
            resolve(null);
          }, HEARTBEAT_TIMEOUT_MS)
        );

        const heartbeatResponse = await Promise.race([heartbeatPromise, timeoutPromise]);

        if (heartbeatResponse) {
          console.log('[Daemon] Heartbeat response:', heartbeatResponse.slice(0, 200));
          wsService.broadcastHeartbeat(heartbeatResponse);
        } else {
          console.log('[Daemon] Heartbeat returned no response (busy or timed out)');
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
