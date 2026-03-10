/**
 * Context Tracker — Screen Context Analysis
 *
 * Maintains current screen context, detects app changes, stuck states,
 * error patterns, and manages activity sessions.
 */

import type { AwarenessConfig } from '../config/types.ts';
import type { ScreenContext, AwarenessEvent } from './types.ts';
import { createSession, endSession, incrementSessionCaptureCount, updateSession } from '../vault/awareness.ts';
import { generateId } from '../vault/schema.ts';
import { StruggleDetector } from './struggle-detector.ts';

// Strong error indicators — always trigger (rare in normal output)
const STRONG_ERROR_PATTERN = /\b(traceback|segfault|SIGSEGV|SIGABRT|panic|undefined is not|cannot read prop|stack overflow|out of memory|unhandled rejection|uncaught exception|TypeError:|ReferenceError:|SyntaxError:|RangeError:|ModuleNotFoundError|ImportError|FileNotFoundError|PermissionError|ConnectionRefusedError|ECONNREFUSED|ENOTFOUND|EPERM|Build failed|Compilation error|npm ERR!)\b/i;

// Weaker indicators — only trigger when accompanied by stack trace context
const WEAK_ERROR_PATTERN = /\b(error|exception|failed|fatal|crash|denied|refused|timeout|ENOENT|EACCES|ECONNREFUSED)\b/i;

// Context that confirms a weak error is real (stack traces, error codes, build output, HTTP errors, etc.)
const ERROR_CONFIRM_PATTERN = /(?:at .+:\d+|line \d+|\.ts:\d+|\.js:\d+|\.py:\d+|\.go:\d+|throw |exit code|status [45]\d{2}|Traceback|^\s+\^|command not found|No such file|permission denied|cannot find module|Module not found|Compilation failed|Build failed|ERR!|npm ERR|error\[\w+\]|✗|✘|FAIL|FAILED|returned non-zero|Process exited)/mi;

// JARVIS own log lines — filter these out from error detection
const JARVIS_LOG_PREFIX = /\[(CaptureEngine|ObserverManager|file-watcher|clipboard|processes|notifications|email|calendar|Daemon|ServiceRegistry|AgentService|WSService|OCREngine|Awareness|DesktopController|Executor|HealthMonitor|ChannelManager|TelegramAdapter|BackgroundAgent|WebSocketServer|EventReactor|Orchestrator|ChannelService|ObserverService)\]/;

// URL pattern in text
const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`[\]]+/;

// File path patterns
const FILE_PATH_PATTERN = /(?:\/[\w.-]+){2,}(?:\.\w+)?|[A-Z]:\\[\w\\.-]+/;

export class ContextTracker {
  private config: AwarenessConfig;
  private currentContext: ScreenContext | null = null;
  private previousContext: ScreenContext | null = null;
  private currentSessionId: string | null = null;
  private currentSessionApps: Set<string> = new Set();
  private sameWindowSince: number = 0;
  private lastOcrTextHash: string = '';
  private lastActivityTimestamp: number = 0;
  private lastErrorText: string = '';
  private lastErrorTimestamp: number = 0;
  private pendingWindowInfo: { appName: string; windowTitle: string } | null = null;
  private struggleDetector: StruggleDetector;

  constructor(config: AwarenessConfig) {
    this.config = config;
    this.struggleDetector = new StruggleDetector({
      graceMs: config.struggle_grace_ms ?? 120_000,
      cooldownMs: config.struggle_cooldown_ms ?? 180_000,
    });
  }

  /**
   * Process a new screen capture. Returns the context and any detected events.
   */
  processCapture(captureId: string, ocrText: string, rawWindowTitle?: string): {
    context: ScreenContext;
    events: AwarenessEvent[];
  } {
    const now = Date.now();
    const events: AwarenessEvent[] = [];

    // Use pending window info from sidecar context_changed if no rawWindowTitle provided
    const effectiveWindowTitle = rawWindowTitle || this.pendingWindowInfo?.windowTitle;
    if (this.pendingWindowInfo && !rawWindowTitle) {
      this.pendingWindowInfo = null; // consumed
    }

    // Parse app name and details from window title or OCR
    const { appName, windowTitle, url, filePath } = this.parseWindowInfo(ocrText, effectiveWindowTitle);

    // Detect context change
    const isAppChange = this.currentContext !== null &&
      (this.currentContext.appName !== appName || this.currentContext.windowTitle !== windowTitle);

    const isSignificantChange = isAppChange || this.currentContext === null;

    // Session management
    const idleGap = this.lastActivityTimestamp > 0 ? (now - this.lastActivityTimestamp) : 0;
    const isIdleReturn = idleGap > 5 * 60 * 1000; // 5 min idle

    if (isAppChange || isIdleReturn || !this.currentSessionId) {
      // End previous session if it exists
      if (this.currentSessionId && isAppChange) {
        this.endCurrentSession();
        events.push({
          type: 'session_ended',
          data: { sessionId: this.currentSessionId, apps: Array.from(this.currentSessionApps) },
          timestamp: now,
        });
      }

      // Start new session
      const session = createSession({ startedAt: now, apps: [appName] });
      this.currentSessionId = session.id;
      this.currentSessionApps = new Set([appName]);
      events.push({
        type: 'session_started',
        data: { sessionId: session.id, appName },
        timestamp: now,
      });
    }

    // Track app in current session
    if (this.currentSessionId && appName) {
      this.currentSessionApps.add(appName);
      incrementSessionCaptureCount(this.currentSessionId);
    }

    // Context change event
    if (isAppChange) {
      events.push({
        type: 'context_changed',
        data: {
          fromApp: this.currentContext?.appName ?? 'unknown',
          toApp: appName,
          fromWindow: this.currentContext?.windowTitle ?? '',
          toWindow: windowTitle,
        },
        timestamp: now,
      });
      this.sameWindowSince = now;
      this.lastOcrTextHash = '';
      this.struggleDetector.reset();
    }

    // Track same-window duration for stuck detection
    if (!isAppChange && this.currentContext) {
      // Same window — check if stuck
      if (this.sameWindowSince === 0) {
        this.sameWindowSince = now;
      }

      const sameWindowDuration = now - this.sameWindowSince;
      const ocrHash = simpleHash(ocrText);
      const textUnchanged = ocrHash === this.lastOcrTextHash;

      if (sameWindowDuration > this.config.stuck_threshold_ms && textUnchanged) {
        events.push({
          type: 'stuck_detected',
          data: {
            windowTitle,
            appName,
            durationMs: sameWindowDuration,
            ocrPreview: ocrText.slice(0, 200),
          },
          timestamp: now,
        });
      }

      this.lastOcrTextHash = ocrHash;
    } else {
      this.sameWindowSince = now;
      this.lastOcrTextHash = simpleHash(ocrText);
    }

    // Struggle detection (behavioral analysis beyond simple stuck)
    const struggleResult = this.struggleDetector.evaluate(ocrText, appName, windowTitle, now);
    if (struggleResult) {
      events.push({
        type: 'struggle_detected',
        data: {
          appName,
          windowTitle,
          appCategory: struggleResult.appCategory,
          compositeScore: struggleResult.compositeScore,
          signals: struggleResult.signals,
          durationMs: struggleResult.durationMs,
          ocrPreview: ocrText.slice(0, 500),
        },
        timestamp: now,
      });
    }

    // Error detection in OCR text
    // First, filter out lines that are JARVIS's own log output
    const filteredOcrText = ocrText
      .split('\n')
      .filter(line => !JARVIS_LOG_PREFIX.test(line))
      .join('\n');

    const strongMatch = filteredOcrText.match(STRONG_ERROR_PATTERN);
    const weakMatch = !strongMatch ? filteredOcrText.match(WEAK_ERROR_PATTERN) : null;
    // Weak errors only fire if there's confirming context (stack trace, etc.)
    const errorMatch = strongMatch ?? (weakMatch && ERROR_CONFIRM_PATTERN.test(filteredOcrText) ? weakMatch : null);

    if (errorMatch) {
      // Cooldown: don't re-fire same error text within 30 seconds
      const sameError = errorMatch[0].toLowerCase() === this.lastErrorText.toLowerCase();
      const cooldownExpired = (now - this.lastErrorTimestamp) > 30_000;

      if (!sameError || cooldownExpired) {
        const idx = filteredOcrText.indexOf(errorMatch[0]);
        const errorContext = filteredOcrText.slice(Math.max(0, idx - 100), idx + 200);

        events.push({
          type: 'error_detected',
          data: {
            errorText: errorMatch[0],
            errorContext: errorContext.trim(),
            appName,
            windowTitle,
          },
          timestamp: now,
        });

        this.lastErrorText = errorMatch[0];
        this.lastErrorTimestamp = now;
      }
    }

    // Build context object
    const context: ScreenContext = {
      captureId,
      timestamp: now,
      appName,
      windowTitle,
      url,
      filePath,
      ocrText,
      sessionId: this.currentSessionId!,
      isSignificantChange,
    };

    // Update state
    this.previousContext = this.currentContext;
    this.currentContext = context;
    this.lastActivityTimestamp = now;

    return { context, events };
  }

  getCurrentContext(): ScreenContext | null {
    return this.currentContext;
  }

  getPreviousContext(): ScreenContext | null {
    return this.previousContext;
  }

  getCurrentSession(): { id: string; topic: string | null; startedAt: number } | null {
    if (!this.currentSessionId) return null;
    return {
      id: this.currentSessionId,
      topic: null, // Topic set later by intelligence layer
      startedAt: this.sameWindowSince || Date.now(),
    };
  }

  /**
   * Get the last known window title (set by updateWindowInfo from sidecar events).
   */
  getLastWindowTitle(): string | undefined {
    return this.currentContext?.windowTitle ?? undefined;
  }

  /**
   * Update cached window info from a sidecar context_changed event.
   * Called externally when the sidecar pushes a window change.
   */
  updateWindowInfo(appName: string, windowTitle: string): void {
    if (!this.currentContext) {
      // No capture processed yet — store as pending info for the first processCapture call
      this.pendingWindowInfo = { appName, windowTitle };
      return;
    }
    // Directly update current context's window info
    this.currentContext = {
      ...this.currentContext,
      appName: appName || this.currentContext.appName,
      windowTitle: windowTitle || this.currentContext.windowTitle,
    };
  }

  /**
   * Report idle/stuck state from sidecar idle_detected event.
   */
  reportIdle(appName: string, durationMs: number): void {
    // The struggle detector already handles stuck detection from processCapture,
    // but this provides an external signal from the sidecar's window observer.
    // We can use it to supplement the stuck detection threshold.
    if (this.currentContext && durationMs > 0) {
      this.sameWindowSince = Date.now() - durationMs;
    }
  }

  endCurrentSession(): void {
    if (this.currentSessionId) {
      try {
        // Update session apps before ending
        updateSession(this.currentSessionId, {
          apps: Array.from(this.currentSessionApps),
        });
        endSession(this.currentSessionId);
      } catch { /* session may not exist in test environments */ }
      this.currentSessionId = null;
      this.currentSessionApps.clear();
    }
  }

  /**
   * Parse window title and OCR text to extract app name, URL, file path.
   */
  private parseWindowInfo(ocrText: string, rawWindowTitle?: string): {
    appName: string;
    windowTitle: string;
    url: string | null;
    filePath: string | null;
  } {
    const windowTitle = rawWindowTitle || '';

    // Extract app name from window title (typically "Content - AppName" or "AppName - Content")
    let appName = 'Unknown';
    if (windowTitle) {
      const parts = windowTitle.split(/\s[-–—]\s/);
      if (parts.length >= 2) {
        // Last part is usually the app name
        appName = parts[parts.length - 1]!.trim();
      } else {
        appName = windowTitle.trim();
      }
    }

    // Extract URL from OCR text or window title
    const urlMatch = (windowTitle + ' ' + ocrText).match(URL_PATTERN);
    const url = urlMatch ? urlMatch[0] : null;

    // Extract file path from window title
    const fileMatch = windowTitle.match(FILE_PATH_PATTERN);
    const filePath = fileMatch ? fileMatch[0] : null;

    return { appName, windowTitle, url, filePath };
  }
}

/**
 * Simple string hash for quick comparison (not cryptographic).
 */
function simpleHash(str: string): string {
  let hash = 0;
  const sample = str.slice(0, 2000); // Only hash first 2000 chars
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}
