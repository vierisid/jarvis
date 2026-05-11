/**
 * Awareness Service — Orchestrator
 *
 * Wires together ContextTracker, Intelligence, SuggestionEngine,
 * ContextGraph, and Analytics into a single service. Consumes pushed
 * events from sidecar observers (screen_capture, context_changed,
 * idle_detected). OCR runs in the sidecar; the brain receives ocr_text
 * inline on the event.
 */

import type { Service, ServiceStatus } from '../daemon/services.ts';
import type { JarvisConfig, AwarenessConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { AwarenessEvent, LiveContext, DailyReport, Suggestion, SessionSummary, WeeklyReport, BehavioralInsight } from './types.ts';
import type { SuggestionType, SuggestionRow } from './types.ts';
import type { SidecarEvent } from '../sidecar/protocol.ts';

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
export class AwarenessService implements Service {
  name = 'awareness';
  private _status: ServiceStatus = 'stopped';

  private config: AwarenessConfig;
  private contextTracker: ContextTracker;
  private intelligence: AwarenessIntelligence;
  private suggestionEngine: SuggestionEngine;
  private contextGraph: ContextGraph;
  private analytics: BehaviorAnalytics;
  private llm: LLMManager;
  private eventCallback: ((event: AwarenessEvent) => void) | null;
  private fetchCapture: ((sidecarId: string, path: string) => Promise<Buffer | null>) | null;
  private cleanupSidecarCaptures: ((cutoffMs: number) => Promise<void>) | null;
  private enabled: boolean;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    jarvisConfig: JarvisConfig,
    llm: LLMManager,
    eventCallback?: (event: AwarenessEvent) => void,
    googleAuth?: { isAuthenticated(): boolean; getAccessToken(): Promise<string> } | null,
    fetchCapture?: (sidecarId: string, path: string) => Promise<Buffer | null>,
    cleanupSidecarCaptures?: (cutoffMs: number) => Promise<void>
  ) {
    const cfg = jarvisConfig.awareness!;
    this.config = cfg;
    this.llm = llm;
    this.eventCallback = eventCallback ?? null;
    this.fetchCapture = fetchCapture ?? null;
    this.cleanupSidecarCaptures = cleanupSidecarCaptures ?? null;
    this.enabled = cfg.enabled;

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
      // Retention cleanup: prunes the DB and (in the future) signals the sidecar
      // to drop expired capture files. The sidecar now owns the on-disk store.
      this.cleanupTimer = setInterval(() => this.cleanupRetention(), 10 * 60 * 1000);

      this._status = 'running';
      console.log('[Awareness] Service started — listening for sidecar events (sidecar-side OCR + context tracking)');
    } catch (err) {
      this._status = 'error';
      console.error('[Awareness] Failed to start:', err instanceof Error ? err.message : err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    this.contextTracker.endCurrentSession();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

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

  getUsageEstimate(): {
    capturesPerHour: number;
    estimatedVisionCallsPerHour: number;
    estimatedTokensPerHour: number;
    note: string;
  } {
    const capturesPerHour = Math.max(1, Math.round(3600000 / Math.max(this.config.capture_interval_ms, 1000)));
    if (!this.config.cloud_vision_enabled) {
      return {
        capturesPerHour,
        estimatedVisionCallsPerHour: 0,
        estimatedTokensPerHour: 0,
        note: 'Cloud vision is disabled, so awareness will not spend LLM vision tokens.',
      };
    }

    const estimatedVisionCallsPerHour = Math.max(
      1,
      Math.min(capturesPerHour, Math.round(3600000 / Math.max(this.config.cloud_vision_cooldown_ms, 1000)))
    );

    return {
      capturesPerHour,
      estimatedVisionCallsPerHour,
      estimatedTokensPerHour: estimatedVisionCallsPerHour * 1400,
      note: 'Estimate is a worst-case approximation based on your capture rate and cloud-vision cooldown.',
    };
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
    const payload = event.payload as Record<string, unknown>;
    const pixelChangePct = (payload.pixel_change_pct as number) ?? 0;
    const captureId = String(payload.capture_id ?? generateId());
    const imagePath = String(payload.image_path ?? '');
    const ocrText = String(payload.ocr_text ?? '');
    const windowTitle = String(payload.window_title ?? '');
    const appName = String(payload.app_name ?? '');

    if (!imagePath) {
      return;
    }

    if (appName || windowTitle) {
      this.contextTracker.updateWindowInfo(appName, windowTitle);
    }

    await this.processCaptureEvent({
      sidecarId,
      captureId,
      capturedAt: event.timestamp,
      pixelChangePct,
      imagePath,
      ocrText,
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

  // ── Retention ──

  // The sidecar owns capture files on its own filesystem. This method prunes
  // the brain-side DB rows and then asks each connected sidecar to drop files
  // older than the longest-tier retention cutoff.
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

      if (fullDeleted > 0 || keyDeleted > 0) {
        console.log(`[Awareness] DB retention cleanup: ${fullDeleted} full, ${keyDeleted} key_moment captures deleted`);
      }

      // Tell sidecars to drop capture files older than the longest tier we
      // still keep DB rows for. Best-effort, fire-and-forget.
      if (this.cleanupSidecarCaptures) {
        this.cleanupSidecarCaptures(keyMomentCutoff).catch(err =>
          console.error('[Awareness] Sidecar capture cleanup failed:', err instanceof Error ? err.message : err)
        );
      }
    } catch (err) {
      console.error('[Awareness] Retention cleanup error:', err instanceof Error ? err.message : err);
    }
  }

  // ── Processing Pipeline ──

  private async processCaptureEvent(data: {
    sidecarId: string;
    captureId: string;
    capturedAt: number;
    pixelChangePct: number;
    imagePath: string;
    ocrText: string;
    windowTitle?: string;
  }): Promise<void> {
    try {
      const ocrText = data.ocrText;

      const windowTitle = data.windowTitle || this.contextTracker.getLastWindowTitle();

      const { context, events } = this.contextTracker.processCapture(
        data.captureId,
        ocrText,
        windowTitle,
        data.capturedAt
      );

      this.contextGraph.linkCaptureToEntities(context);

      createCapture({
        timestamp: context.timestamp,
        sessionId: context.sessionId,
        sidecarId: data.sidecarId,
        imagePath: data.imagePath,
        pixelChangePct: data.pixelChangePct,
        ocrText,
        appName: context.appName,
        windowTitle: context.windowTitle,
        url: context.url ?? undefined,
        filePath: context.filePath ?? undefined,
      });

      const keyMomentEventTypes = ['error_detected', 'stuck_detected', 'context_changed'];
      if (events.some(e => keyMomentEventTypes.includes(e.type))) {
        try { updateCaptureRetention(data.captureId, 'key_moment'); } catch { /* best-effort */ }
      }

      try {
        createObservation('screen_capture', {
          captureId: data.captureId,
          appName: context.appName,
          windowTitle: context.windowTitle,
          ocrPreview: ocrText.slice(0, 200),
        });
      } catch { /* observation storage is best-effort */ }

      let cloudAnalysis: string | undefined;
      if (
        this.config.cloud_vision_enabled &&
        this.fetchCapture &&
        this.intelligence.shouldEscalateToCloud(context, events)
      ) {
        const imageBuffer = await this.fetchCapture(data.sidecarId, data.imagePath).catch(err => {
          console.error('[Awareness] fetch_capture failed:', err instanceof Error ? err.message : err);
          return null;
        });

        if (imageBuffer) {
          const base64 = imageBuffer.toString('base64');

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
