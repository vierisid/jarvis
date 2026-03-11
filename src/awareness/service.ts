/**
 * Awareness Service — Orchestrator
 *
 * Wires together OCREngine, ContextTracker, Intelligence,
 * SuggestionEngine, ContextGraph, and Analytics into a single service.
 * Consumes pushed events from sidecar observers (screen_capture,
 * context_changed, idle_detected) instead of polling.
 */

import type { Service, ServiceStatus } from '../daemon/services.ts';
import type { JarvisConfig, AwarenessConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { AwarenessEvent, LiveContext, DailyReport, Suggestion, SessionSummary, WeeklyReport, BehavioralInsight } from './types.ts';
import type { SuggestionType, SuggestionRow } from './types.ts';
import type { SidecarEvent, BinaryDataInline } from '../sidecar/protocol.ts';

import { OCREngine } from './ocr-engine.ts';
import { ContextTracker } from './context-tracker.ts';
import { AwarenessIntelligence } from './intelligence.ts';
import { SuggestionEngine } from './suggestion-engine.ts';
import { ContextGraph } from './context-graph.ts';
import { BehaviorAnalytics } from './analytics.ts';
import {
  createCapture,
  getCapturesForSession,
  getSession,
  updateSession,
  updateCaptureRetention,
  deleteCapturesBefore,
  markSuggestionDelivered,
  markSuggestionDismissed,
  markSuggestionActedOn,
  getRecentSuggestions,
} from '../vault/awareness.ts';
import { createObservation } from '../vault/observations.ts';
import { getUpcoming } from '../vault/commitments.ts';
import { generateId } from '../vault/schema.ts';
import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let sharp: any = null;
try {
  sharp = (await import('sharp')).default;
} catch { /* sharp not available — thumbnails disabled */ }

export class AwarenessService implements Service {
  name = 'awareness';
  private _status: ServiceStatus = 'stopped';

  private config: AwarenessConfig;
  private ocrEngine: OCREngine;
  private contextTracker: ContextTracker;
  private intelligence: AwarenessIntelligence;
  private suggestionEngine: SuggestionEngine;
  private contextGraph: ContextGraph;
  private analytics: BehaviorAnalytics;
  private llm: LLMManager;
  private eventCallback: ((event: AwarenessEvent) => void) | null;
  private enabled: boolean;
  private captureDir: string;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    jarvisConfig: JarvisConfig,
    llm: LLMManager,
    eventCallback?: (event: AwarenessEvent) => void,
    googleAuth?: { isAuthenticated(): boolean; getAccessToken(): Promise<string> } | null
  ) {
    const cfg = jarvisConfig.awareness!;
    this.config = cfg;
    this.llm = llm;
    this.eventCallback = eventCallback ?? null;
    this.enabled = cfg.enabled;
    this.captureDir = cfg.capture_dir.replace(/^~/, os.homedir());

    this.ocrEngine = new OCREngine();
    this.contextTracker = new ContextTracker(cfg);
    this.intelligence = new AwarenessIntelligence(
      llm,
      cfg.cloud_vision_enabled ? cfg.cloud_vision_cooldown_ms : Infinity
    );
    this.suggestionEngine = new SuggestionEngine(cfg.suggestion_rate_limit_ms, {
      googleAuth: googleAuth ?? null,
      getUpcomingCommitments: () => getUpcoming(10).map(c => ({
        what: c.what,
        when_due: c.when_due,
        priority: c.priority,
      })),
    });
    this.contextGraph = new ContextGraph();
    this.analytics = new BehaviorAnalytics(llm);
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      console.log('[Awareness] Disabled by config');
      this._status = 'stopped';
      return;
    }

    this._status = 'starting';

    try {
      // 1. Initialize OCR engine
      await this.ocrEngine.initialize();

      // 2. Ensure capture directory exists
      mkdirSync(this.captureDir, { recursive: true });

      // 3. Start retention cleanup every 10 minutes
      this.cleanupTimer = setInterval(() => this.cleanupRetention(), 10 * 60 * 1000);

      this._status = 'running';
      console.log('[Awareness] Service started — listening for sidecar events (OCR + context tracking active)');
    } catch (err) {
      this._status = 'error';
      console.error('[Awareness] Failed to start:', err instanceof Error ? err.message : err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    // End current session
    this.contextTracker.endCurrentSession();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    await this.ocrEngine.shutdown();

    this._status = 'stopped';
    console.log('[Awareness] Service stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }

  // ── Public API ──

  getLiveContext(): LiveContext {
    return this.analytics.getLiveContext(this.contextTracker, this._status === 'running');
  }

  getCurrentSession() {
    return this.contextTracker.getCurrentSession();
  }

  getRecentSuggestionsList(limit?: number, type?: SuggestionType): SuggestionRow[] {
    return getRecentSuggestions(limit, type);
  }

  dismissSuggestion(id: string): void {
    markSuggestionDismissed(id);
  }

  actOnSuggestion(id: string): void {
    markSuggestionActedOn(id);
  }

  async generateReport(date?: string): Promise<DailyReport> {
    return this.analytics.generateDailyReport(date);
  }

  getSessionHistory(limit?: number): SessionSummary[] {
    return this.analytics.getSessionHistory(limit);
  }

  async generateWeeklyReport(weekStart?: string): Promise<WeeklyReport> {
    return this.analytics.generateWeeklyReport(weekStart);
  }

  getBehavioralInsights(days?: number): BehavioralInsight[] {
    return this.analytics.getBehavioralInsights(days);
  }

  toggle(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this._status === 'running') {
      this.stop().catch(err =>
        console.error('[Awareness] Error stopping:', err)
      );
    } else if (enabled && this._status === 'stopped') {
      this.start().catch(err =>
        console.error('[Awareness] Error starting:', err)
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Sidecar Event Handler ──

  async handleSidecarEvent(sidecarId: string, event: SidecarEvent): Promise<void> {
    if (this._status !== 'running') return;

    try {
      switch (event.event_type) {
        case 'screen_capture':
          await this.handleScreenCapture(sidecarId, event);
          break;
        case 'context_changed':
          this.handleContextChanged(sidecarId, event);
          break;
        case 'idle_detected':
          this.handleIdleDetected(sidecarId, event);
          break;
      }
    } catch (err) {
      console.error(`[Awareness] Error handling ${event.event_type} from ${sidecarId}:`, err instanceof Error ? err.message : err);
    }
  }

  // ── Event Handlers ──

  private async handleScreenCapture(sidecarId: string, event: SidecarEvent): Promise<void> {
    // Extract image buffer from binary data
    let imageBuffer: Buffer | null = null;

    if (event.binary) {
      if (event.binary.type === 'inline' && 'data' in event.binary) {
        imageBuffer = Buffer.from((event.binary as BinaryDataInline).data, 'base64');
      } else if (event.binary.type === 'ref') {
        // Binary ref: payload._binary was resolved by SidecarConnection
        const resolved = (event.payload as Record<string, unknown>)._binary as Buffer | undefined;
        if (resolved) {
          imageBuffer = resolved;
        }
      }
    }

    if (!imageBuffer || imageBuffer.length < 1000) {
      return;
    }

    const payload = event.payload as Record<string, unknown>;
    const pixelChangePct = (payload.pixel_change_pct as number) ?? 0;
    const captureId = String(payload.capture_id ?? generateId());
    const windowTitle = String(payload.window_title ?? '');
    const appName = String(payload.app_name ?? '');

    // Update context tracker with window info from sidecar
    if (appName || windowTitle) {
      this.contextTracker.updateWindowInfo(appName, windowTitle);
    }

    // Save to disk
    const imagePath = await this.saveCapture(imageBuffer, event.timestamp);
    const thumbnailPath = await this.generateThumbnail(imagePath);

    // Run through existing pipeline
    await this.processCaptureEvent({
      captureId,
      pixelChangePct,
      imagePath,
      thumbnailPath: thumbnailPath ?? undefined,
      imageBuffer,
      windowTitle,
    });
  }

  private handleContextChanged(_sidecarId: string, event: SidecarEvent): void {
    const payload = event.payload as Record<string, unknown>;
    const toApp = String(payload.to_app ?? '');
    const toWindow = String(payload.to_window ?? '');

    // Feed context change to tracker (simulates what processCapture does for window changes)
    if (toApp || toWindow) {
      this.contextTracker.updateWindowInfo(toApp, toWindow);
    }
  }

  private handleIdleDetected(_sidecarId: string, event: SidecarEvent): void {
    const payload = event.payload as Record<string, unknown>;
    const durationMs = (payload.duration_ms as number) ?? 0;
    const appName = String(payload.app_name ?? '');

    // Feed idle info to context tracker for stuck detection
    this.contextTracker.reportIdle(appName, durationMs);
  }

  // ── Capture Storage ──

  private async saveCapture(imageBuffer: Buffer, timestamp: number): Promise<string> {
    const date = new Date(timestamp);
    const dateDir = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const fileName = `${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}.png`;

    const dir = path.join(this.captureDir, dateDir);
    mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, fileName);
    await Bun.write(filePath, imageBuffer);

    return filePath;
  }

  private async generateThumbnail(fullImagePath: string): Promise<string | null> {
    if (!sharp) return null;

    const thumbPath = fullImagePath.replace(/\.png$/, '-thumb.jpg');
    try {
      await sharp(fullImagePath).resize(200).jpeg({ quality: 60 }).toFile(thumbPath);
      return thumbPath;
    } catch {
      return null;
    }
  }

  private cleanupRetention(): void {
    try {
      const now = Date.now();
      const fullCutoff = now - (this.config.retention.full_hours * 60 * 60 * 1000);
      const keyMomentCutoff = now - (this.config.retention.key_moment_hours * 60 * 60 * 1000);

      let fullDeleted = 0;
      let keyDeleted = 0;
      try {
        fullDeleted = deleteCapturesBefore(fullCutoff, 'full');
        keyDeleted = deleteCapturesBefore(keyMomentCutoff, 'key_moment');
      } catch { /* DB may not be initialized in tests */ }

      if (!existsSync(this.captureDir)) return;

      const dateDirs = readdirSync(this.captureDir);
      for (const dateDir of dateDirs) {
        const dirPath = path.join(this.captureDir, dateDir);
        try {
          const stat = statSync(dirPath);
          if (!stat.isDirectory()) continue;

          const files = readdirSync(dirPath);
          let remaining = files.length;

          for (const file of files) {
            const filePath = path.join(dirPath, file);
            try {
              const fileStat = statSync(filePath);
              if (fileStat.mtimeMs < keyMomentCutoff) {
                unlinkSync(filePath);
                remaining--;
              }
            } catch { /* file already gone */ }
          }

          if (remaining === 0) {
            try {
              if (readdirSync(dirPath).length === 0) rmdirSync(dirPath);
            } catch { /* ignore */ }
          }
        } catch { /* skip */ }
      }

      if (fullDeleted > 0 || keyDeleted > 0) {
        console.log(`[Awareness] Retention cleanup: ${fullDeleted} full, ${keyDeleted} key_moment captures deleted`);
      }
    } catch (err) {
      console.error('[Awareness] Retention cleanup error:', err instanceof Error ? err.message : err);
    }
  }

  // ── Processing Pipeline ──

  private async processCaptureEvent(data: {
    captureId: string;
    pixelChangePct: number;
    imagePath: string;
    thumbnailPath?: string;
    imageBuffer: Buffer;
    windowTitle?: string;
  }): Promise<void> {
    try {
      // 1. OCR — extract text from screenshot
      let ocrText = '';
      if (this.ocrEngine.isReady()) {
        const ocr = await this.ocrEngine.extractText(data.imageBuffer);
        ocrText = ocr.text;
      }

      // 2. Context tracking — detect app changes, stuck states, errors
      // Use window title from capture source (PowerShell/sidecar), fall back to tracker state
      const windowTitle = data.windowTitle || this.contextTracker.getLastWindowTitle();

      const { context, events } = this.contextTracker.processCapture(
        data.captureId,
        ocrText,
        windowTitle
      );

      // 3. Entity linking
      this.contextGraph.linkCaptureToEntities(context);

      // 4. Store capture metadata in DB
      createCapture({
        timestamp: context.timestamp,
        sessionId: context.sessionId,
        imagePath: data.imagePath,
        thumbnailPath: data.thumbnailPath ?? undefined,
        pixelChangePct: data.pixelChangePct,
        ocrText,
        appName: context.appName,
        windowTitle: context.windowTitle,
        url: context.url ?? undefined,
        filePath: context.filePath ?? undefined,
      });

      // 4b. Promote to key_moment retention if significant events fired
      const keyMomentEventTypes = ['error_detected', 'stuck_detected', 'context_changed'];
      if (events.some(e => keyMomentEventTypes.includes(e.type))) {
        try { updateCaptureRetention(data.captureId, 'key_moment'); } catch { /* best-effort */ }
      }

      // 5. Store as observation
      try {
        createObservation('screen_capture', {
          captureId: data.captureId,
          appName: context.appName,
          windowTitle: context.windowTitle,
          ocrPreview: ocrText.slice(0, 200),
        });
      } catch { /* observation storage is best-effort */ }

      // 6. Cloud vision escalation (async, non-blocking)
      let cloudAnalysis: string | undefined;
      if (this.config.cloud_vision_enabled && this.intelligence.shouldEscalateToCloud(context, events)) {
        const base64 = data.imageBuffer.toString('base64');

        const struggleEvent = events.find(e => e.type === 'struggle_detected');
        if (struggleEvent) {
          cloudAnalysis = await this.intelligence.analyzeStruggle(
            base64,
            context,
            String(struggleEvent.data.appCategory ?? 'general'),
            (struggleEvent.data.signals as Array<{ name: string; score: number; detail: string }>) ?? [],
            String(struggleEvent.data.ocrPreview ?? context.ocrText.slice(0, 500))
          );
        } else if (context.isSignificantChange) {
          cloudAnalysis = await this.intelligence.analyzeDelta(
            base64,
            context,
            this.contextTracker.getPreviousContext()
          );
        } else {
          cloudAnalysis = await this.intelligence.analyzeGeneral(base64, context);
        }
      }

      // 7. Suggestion evaluation
      const suggestion = await this.suggestionEngine.evaluate(context, events, cloudAnalysis);
      if (suggestion) {
        try { markSuggestionDelivered(suggestion.id, 'websocket'); } catch { /* ignore */ }

        const suggestionEvent: AwarenessEvent = {
          type: 'suggestion_ready',
          data: {
            id: suggestion.id,
            type: suggestion.type,
            title: suggestion.title,
            body: suggestion.body,
          },
          timestamp: Date.now(),
        };
        events.push(suggestionEvent);
      }

      // 8. Emit all events
      for (const event of events) {
        this.eventCallback?.(event);
      }

      // 9. Session topic inference (async, non-blocking)
      const sessionEnd = events.find(e => e.type === 'session_ended');
      if (sessionEnd) {
        this.inferSessionTopic(sessionEnd.data as { sessionId: string; apps: string[] }).catch(err =>
          console.error('[Awareness] Session topic inference failed:', err instanceof Error ? err.message : err)
        );
      }
    } catch (err) {
      console.error('[Awareness] Pipeline error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Asynchronously infer topic and summary for a completed session via LLM.
   */
  private async inferSessionTopic(data: { sessionId: string; apps: string[] }): Promise<void> {
    const { sessionId, apps } = data;
    if (!sessionId) return;

    try {
      const session = getSession(sessionId);
      if (!session) return;

      const startedAt = session.started_at;
      const endedAt = session.ended_at ?? Date.now();
      const durationMinutes = Math.round((endedAt - startedAt) / 60000);

      if (durationMinutes < 2) return;

      const captures = getCapturesForSession(sessionId);
      const sampleOcrTexts = captures
        .filter(c => c.ocr_text && c.ocr_text.length > 20)
        .slice(0, 5)
        .map(c => c.ocr_text!);

      if (sampleOcrTexts.length === 0) return;

      const { topic, summary } = await this.intelligence.summarizeSession(
        apps,
        session.capture_count,
        durationMinutes,
        sampleOcrTexts
      );

      updateSession(sessionId, { topic, summary });
      console.log(`[Awareness] Session topic: "${topic}" (${durationMinutes}min, ${apps.join(', ')})`);
    } catch (err) {
      console.error('[Awareness] Topic inference error:', err instanceof Error ? err.message : err);
    }
  }
}
