/**
 * Suggestion Engine — Proactive Help
 *
 * Evaluates screen context and events to generate actionable suggestions.
 * Rate-limited and deduped to avoid being annoying.
 * Supports: error, stuck, automation, knowledge, schedule, break, general.
 */

import type { ScreenContext, AwarenessEvent, Suggestion, SuggestionType } from './types.ts';
import { createSuggestion, getSuggestionCountSince, getCaptureCountSince } from '../vault/awareness.ts';
import { searchEntitiesByName } from '../vault/entities.ts';
import { findFacts } from '../vault/facts.ts';

const MAX_DEDUP_HASHES = 50;

export type ScheduleDeps = {
  googleAuth?: { isAuthenticated(): boolean; getAccessToken(): Promise<string> } | null;
  getUpcomingCommitments?: () => Array<{ what: string; when_due: number | null; priority: string }>;
};

// Per-type rate limits — errors fire fast, proactive suggestions less often
const TYPE_RATE_LIMITS: Record<string, number> = {
  error: 15_000,       // 15s — errors are urgent
  struggle: 90_000,    // 90s — behavioral, stays true a while
  stuck: 60_000,       // 60s — persistent state
  automation: 120_000, // 2min — proactive, shouldn't nag
  knowledge: 120_000,  // 2min
  schedule: 300_000,   // 5min — calendar events don't change fast
  break: 600_000,      // 10min — break reminders shouldn't nag
  general: 60_000,     // 1min — cloud insight
};

export class SuggestionEngine {
  private defaultRateLimitMs: number;
  private lastSuggestionByType = new Map<string, number>();
  private recentHashes: Set<string> = new Set();
  private hashQueue: string[] = [];

  // Gap 3: automation detection state
  private actionHistory: Array<{ appName: string; windowTitle: string; timestamp: number }> = [];

  // Gap 4: knowledge dedup
  private lastKnowledgeEntityId = '';

  // Gap 5: schedule check throttle
  private scheduleDeps: ScheduleDeps | null;
  private lastScheduleCheckAt = 0;
  private lastScheduleEventId = '';

  constructor(rateLimitMs: number = 60000, scheduleDeps?: ScheduleDeps) {
    this.defaultRateLimitMs = rateLimitMs;
    this.scheduleDeps = scheduleDeps ?? null;
  }

  /**
   * Evaluate context and events for a potential suggestion.
   * Returns null if no suggestion or rate-limited.
   */
  async evaluate(
    context: ScreenContext,
    events: AwarenessEvent[],
    cloudAnalysis?: string
  ): Promise<Suggestion | null> {
    const now = Date.now();

    // Try each suggestion type in priority order
    // Each candidate is checked against its own per-type rate limit
    const candidates: (Suggestion | null)[] = [
      this.checkError(context, events),
      this.checkStruggle(context, events, cloudAnalysis),
      this.checkStuck(context, events),
      this.checkAutomation(context, events),
      this.checkKnowledge(context, events),
      null, // placeholder for async schedule
      this.checkBreak(context),
      this.checkCloudInsight(context, cloudAnalysis),
    ];

    // Async schedule check (only if nothing higher-priority passed)
    if (candidates.every(c => c === null)) {
      (candidates as (Suggestion | null)[])[5] = await this.checkSchedule(context);
    }

    // Find the first non-null candidate that passes its per-type rate limit
    let suggestion: Suggestion | null = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const typeLimit = TYPE_RATE_LIMITS[candidate.type] ?? this.defaultRateLimitMs;
      const lastFired = this.lastSuggestionByType.get(candidate.type) ?? 0;
      if (now - lastFired < typeLimit) continue; // rate-limited for this type
      suggestion = candidate;
      break;
    }

    if (!suggestion) return null;

    // Dedup check
    const hash = this.hashSuggestion(suggestion);
    if (this.recentHashes.has(hash)) return null;

    // Store and track
    this.addHash(hash);
    this.lastSuggestionByType.set(suggestion.type, now);

    // Persist to DB
    const row = createSuggestion({
      type: suggestion.type,
      triggerCaptureId: context.captureId,
      title: suggestion.title,
      body: suggestion.body,
      context: suggestion.context ?? undefined,
    });

    return {
      ...suggestion,
      id: row.id,
    };
  }

  /**
   * Check for error-related suggestions.
   */
  private checkError(context: ScreenContext, events: AwarenessEvent[]): Suggestion | null {
    const errorEvent = events.find(e => e.type === 'error_detected');
    if (!errorEvent) return null;

    const errorText = String(errorEvent.data.errorText ?? '');
    const errorContext = String(errorEvent.data.errorContext ?? '');

    return {
      id: '', // set by DB
      type: 'error',
      title: `Error detected in ${context.appName}`,
      body: `I spotted "${errorText.slice(0, 80)}". Researching a fix now...`,
      triggerCaptureId: context.captureId,
      context: { errorText, errorContext, appName: context.appName },
    };
  }

  /**
   * Check for struggle-state suggestions with deep analysis.
   */
  private checkStruggle(
    context: ScreenContext,
    events: AwarenessEvent[],
    cloudAnalysis?: string
  ): Suggestion | null {
    const struggleEvent = events.find(e => e.type === 'struggle_detected');
    if (!struggleEvent) return null;

    const appCategory = String(struggleEvent.data.appCategory ?? 'general');
    const compositeScore = struggleEvent.data.compositeScore as number;
    const signals = struggleEvent.data.signals as Array<{ name: string; score: number; detail: string }>;
    const durationMs = struggleEvent.data.durationMs as number;
    const minutes = Math.round(durationMs / 60000);

    // Use cloud analysis as body if available, otherwise contextual fallback
    const body = cloudAnalysis && cloudAnalysis.length > 20
      ? cloudAnalysis.slice(0, 500)
      : this.buildStruggleFallback(appCategory, context.appName, minutes, signals);

    const titleMap: Record<string, string> = {
      code_editor: 'I think I see the issue in your code',
      terminal: 'I noticed the command keeps failing',
      browser: 'Need help with this page?',
      creative_app: `Let me help you find that in ${context.appName}`,
      puzzle_game: 'I might have a hint for this puzzle',
      general: 'You seem stuck — let me take a look',
    };

    return {
      id: '',
      type: 'struggle',
      title: titleMap[appCategory] ?? titleMap.general!,
      body,
      triggerCaptureId: context.captureId,
      context: {
        appName: context.appName,
        windowTitle: context.windowTitle,
        appCategory,
        compositeScore,
        durationMs,
        signals: signals.map(s => s.name),
        source: cloudAnalysis ? 'cloud_vision' : 'behavioral',
      },
    };
  }

  private buildStruggleFallback(
    appCategory: string,
    appName: string,
    minutes: number,
    signals: Array<{ name: string; score: number; detail: string }>
  ): string {
    const topSignal = signals.sort((a, b) => b.score - a.score)[0]!;

    const messages: Record<string, string> = {
      code_editor: `I've been watching you edit this code for ${minutes}+ minutes and it looks like you might be stuck. Let me analyze your code for issues...`,
      terminal: `You've been running into the same issue in the terminal for a while. Let me look into what's going wrong...`,
      browser: `You've been on this page for a while without finding what you need. Want me to help navigate?`,
      creative_app: `You seem to be looking for something in ${appName}. Let me help you find it...`,
      puzzle_game: `Stuck on this puzzle? Let me analyze the board and suggest a move...`,
      general: `You've been working on this for ${minutes}+ minutes with a lot of back-and-forth. Want me to help figure out what's blocking you?`,
    };

    return messages[appCategory] ?? messages.general!;
  }

  /**
   * Check for stuck-state suggestions.
   */
  private checkStuck(context: ScreenContext, events: AwarenessEvent[]): Suggestion | null {
    const stuckEvent = events.find(e => e.type === 'stuck_detected');
    if (!stuckEvent) return null;

    const durationMs = stuckEvent.data.durationMs as number;
    const minutes = Math.round(durationMs / 60000);

    return {
      id: '',
      type: 'stuck',
      title: `Stuck on ${context.appName}?`,
      body: `You've been on the same screen for ${minutes}+ minutes. Want me to help with what you're working on?`,
      triggerCaptureId: context.captureId,
      context: { appName: context.appName, windowTitle: context.windowTitle, durationMs },
    };
  }

  /**
   * Detect repetitive app-switching patterns (automation opportunities).
   * Tracks action history and looks for A→B→A→B patterns (3+ repeats in 5 min).
   */
  private checkAutomation(context: ScreenContext, events: AwarenessEvent[]): Suggestion | null {
    // Track action history
    this.actionHistory.push({
      appName: context.appName,
      windowTitle: context.windowTitle,
      timestamp: context.timestamp,
    });

    // Trim to last 5 minutes
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    this.actionHistory = this.actionHistory.filter(a => a.timestamp > fiveMinAgo);

    // Need a context change and sufficient history
    if (!events.some(e => e.type === 'context_changed')) return null;
    if (this.actionHistory.length < 6) return null;

    // Count app-pair transitions
    const transitions = new Map<string, number>();
    for (let i = 1; i < this.actionHistory.length; i++) {
      const from = this.actionHistory[i - 1]!.appName;
      const to = this.actionHistory[i]!.appName;
      if (from !== to) {
        const key = `${from}→${to}`;
        transitions.set(key, (transitions.get(key) ?? 0) + 1);
      }
    }

    // Find most repeated transition
    let maxTransition = '';
    let maxCount = 0;
    for (const [key, count] of transitions) {
      if (count > maxCount) {
        maxTransition = key;
        maxCount = count;
      }
    }

    if (maxCount >= 3) {
      const [fromApp, toApp] = maxTransition.split('→');
      return {
        id: '',
        type: 'automation',
        title: `Repetitive pattern: ${fromApp} ↔ ${toApp}`,
        body: `You've switched between ${fromApp} and ${toApp} ${maxCount} times recently. Want me to create a workflow to automate this?`,
        triggerCaptureId: context.captureId,
        context: { fromApp, toApp, count: maxCount, pattern: 'app_switch' },
      };
    }

    return null;
  }

  /**
   * Surface relevant vault knowledge when context changes to a recognized entity/project.
   */
  private checkKnowledge(context: ScreenContext, events: AwarenessEvent[]): Suggestion | null {
    if (!events.some(e => e.type === 'context_changed')) return null;

    try {
      // Extract meaningful words from window title
      const words = (context.windowTitle || '')
        .split(/\s+[-–—|/\\]\s+|\s+/)
        .filter(w => w.length >= 3)
        .slice(0, 5);

      for (const word of words) {
        const entities = searchEntitiesByName(word);
        const relevant = entities.filter(e =>
          e.type === 'project' || e.type === 'concept' || e.type === 'person'
        );

        for (const entity of relevant.slice(0, 3)) {
          if (entity.id === this.lastKnowledgeEntityId) continue;

          const facts = findFacts({ subject_id: entity.id });
          if (facts.length === 0) continue;

          this.lastKnowledgeEntityId = entity.id;

          const factSummary = facts
            .slice(0, 3)
            .map(f => `${f.predicate}: ${f.object}`)
            .join('; ');

          return {
            id: '',
            type: 'knowledge',
            title: `Relevant info: ${entity.name}`,
            body: `I noticed you're working with ${entity.name}. Here's what I know: ${factSummary}`,
            triggerCaptureId: context.captureId,
            context: { entityId: entity.id, entityName: entity.name, entityType: entity.type, factCount: facts.length },
          };
        }
      }
    } catch { /* vault query failure — non-fatal */ }

    return null;
  }

  /**
   * Check upcoming calendar events and vault commitments.
   * Self-throttled to check every 5 minutes.
   */
  private async checkSchedule(context: ScreenContext): Promise<Suggestion | null> {
    const now = Date.now();
    if (now - this.lastScheduleCheckAt < 5 * 60 * 1000) return null;
    this.lastScheduleCheckAt = now;

    if (!this.scheduleDeps) return null;

    try {
      // 1. Check vault commitments
      if (this.scheduleDeps.getUpcomingCommitments) {
        const commitments = this.scheduleDeps.getUpcomingCommitments();
        for (const c of commitments) {
          if (!c.when_due) continue;
          const minutesUntilDue = (c.when_due - now) / 60_000;
          if (minutesUntilDue > 0 && minutesUntilDue <= 15) {
            return {
              id: '',
              type: 'schedule',
              title: 'Commitment due soon',
              body: `"${c.what}" is due in ${Math.round(minutesUntilDue)} minutes.`,
              triggerCaptureId: context.captureId,
              context: { commitment: c.what, minutesUntilDue: Math.round(minutesUntilDue), priority: c.priority },
            };
          }
        }
      }

      // 2. Check Google Calendar
      if (this.scheduleDeps.googleAuth?.isAuthenticated()) {
        const { listUpcomingEvents } = await import('../integrations/google-api.ts');
        const token = await this.scheduleDeps.googleAuth.getAccessToken();
        const nowIso = new Date().toISOString();
        const in20Min = new Date(now + 20 * 60_000).toISOString();

        const events = await listUpcomingEvents(token, 'primary', nowIso, in20Min, 5);

        for (const event of events) {
          if (event.id === this.lastScheduleEventId) continue;

          const startTime = new Date(event.start).getTime();
          const minutesUntil = (startTime - now) / 60_000;

          if (minutesUntil > 0 && minutesUntil <= 15) {
            this.lastScheduleEventId = event.id;

            const attendeeInfo = event.attendees.length > 0
              ? ` with ${event.attendees.slice(0, 3).join(', ')}`
              : '';

            return {
              id: '',
              type: 'schedule',
              title: `Upcoming: ${event.summary}`,
              body: `"${event.summary}"${attendeeInfo} starts in ${Math.round(minutesUntil)} minutes.${event.location ? ` Location: ${event.location}` : ''}`,
              triggerCaptureId: context.captureId,
              context: { calendarEventId: event.id, summary: event.summary, minutesUntil: Math.round(minutesUntil) },
            };
          }
        }
      }
    } catch (err) {
      // Calendar may not be configured — this is normal
      if (err instanceof Error && !err.message.includes('403')) {
        console.error('[SuggestionEngine] Schedule check error:', err.message);
      }
    }

    return null;
  }

  /**
   * Check if user needs a break (>90 min continuous activity).
   */
  private checkBreak(context: ScreenContext): Suggestion | null {
    try {
      const ninetyMinAgo = Date.now() - 90 * 60 * 1000;

      // Don't suggest a break if we already suggested one recently
      const recentBreakSuggestions = getSuggestionCountSince(ninetyMinAgo);
      if (recentBreakSuggestions > 2) return null;

      // Check if user has been continuously active for 90+ minutes
      // At ~7s per capture, 90 min = ~770 captures
      const captureCount = getCaptureCountSince(ninetyMinAgo);
      if (captureCount < 700) return null;

      return {
        id: '',
        type: 'break',
        title: 'Time for a break?',
        body: `You've been working for over 90 minutes straight. A short break can boost focus and creativity.`,
        triggerCaptureId: context.captureId,
        context: { captureCount, minutesActive: Math.round((captureCount * 7) / 60) },
      };
    } catch { /* ignore */ }

    return null;
  }

  /**
   * Generate suggestion from cloud analysis insight.
   */
  private checkCloudInsight(context: ScreenContext, cloudAnalysis?: string): Suggestion | null {
    if (!cloudAnalysis || cloudAnalysis.length < 20) return null;

    // Only suggest if the analysis contains actionable content
    const actionablePatterns = /\b(suggest|try|consider|could|should|might want|tip|hint|recommendation)\b/i;
    if (!actionablePatterns.test(cloudAnalysis)) return null;

    return {
      id: '',
      type: 'general',
      title: `Insight for ${context.appName}`,
      body: cloudAnalysis.slice(0, 300),
      triggerCaptureId: context.captureId,
      context: { appName: context.appName, source: 'cloud_vision' },
    };
  }

  /**
   * Simple hash for dedup.
   */
  private hashSuggestion(suggestion: Omit<Suggestion, 'id'>): string {
    // Include body snippet in hash so different errors with same title aren't deduplicated
    const bodySnippet = (suggestion.body || '').slice(0, 80);
    return `${suggestion.type}:${suggestion.title}:${bodySnippet}`;
  }

  /**
   * Track hash with FIFO eviction.
   */
  private addHash(hash: string): void {
    this.recentHashes.add(hash);
    this.hashQueue.push(hash);

    if (this.hashQueue.length > MAX_DEDUP_HASHES) {
      const oldest = this.hashQueue.shift()!;
      this.recentHashes.delete(oldest);
    }
  }
}
