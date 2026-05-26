/**
 * Behavior Analytics — Daily Reports & Usage Stats
 *
 * Aggregates screen capture data into daily productivity reports,
 * app usage breakdowns, focus scores, and session histories.
 */

import type { LLMManager } from '../llm/manager.ts';
import type { DailyReport, LiveContext, SessionSummary, AppUsageStat, WeeklyReport, BehavioralInsight } from './types.ts';
import { generateId } from '../vault/schema.ts';
import {
  getCapturesInRange,
  getAppUsageStats,
  getRecentSessions,
  getCaptureCountSince,
} from '../vault/awareness.ts';
import { getSuggestionStats, getSuggestionCountSince } from '../vault/awareness.ts';
import type { ContextTracker } from './context-tracker.ts';

export class BehaviorAnalytics {
  private llm: LLMManager;

  constructor(llm: LLMManager) {
    this.llm = llm;
  }

  /**
   * Generate a daily productivity report.
   * @param date — Date string 'YYYY-MM-DD' or undefined for today
   */
  async generateDailyReport(date?: string): Promise<DailyReport> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const dayStart = new Date(targetDate + 'T00:00:00').getTime();
    const dayEnd = new Date(targetDate + 'T23:59:59.999').getTime();

    // Get captures and compute stats
    const captures = getCapturesInRange(dayStart, dayEnd);
    const appBreakdown = getAppUsageStats(dayStart, dayEnd);
    const suggestionStats = getSuggestionStats(dayStart, dayEnd);

    // Get sessions for the day
    const allSessions = getRecentSessions(100);
    const daySessions = allSessions.filter(s => s.started_at >= dayStart && s.started_at <= dayEnd);

    // Compute focus metrics
    const contextSwitches = captures.filter((c, i) =>
      i > 0 && c.app_name !== captures[i - 1]!.app_name
    ).length;

    const totalActiveMinutes = Math.round((captures.length * 7) / 60); // ~7s per capture

    // Focus score: fewer context switches per hour = higher focus
    const activeHours = Math.max(totalActiveMinutes / 60, 0.1);
    const switchesPerHour = contextSwitches / activeHours;
    // Score: 100 for 0 switches/hr, ~50 for 10, ~20 for 30+
    const focusScore = Math.max(0, Math.min(100, Math.round(100 * Math.exp(-switchesPerHour / 15))));

    // Longest continuous focus (same app streak)
    let longestStreak = 0;
    let currentStreak = 1;
    for (let i = 1; i < captures.length; i++) {
      if (captures[i]!.app_name === captures[i - 1]!.app_name) {
        currentStreak++;
      } else {
        longestStreak = Math.max(longestStreak, currentStreak);
        currentStreak = 1;
      }
    }
    longestStreak = Math.max(longestStreak, currentStreak);
    const longestFocusMinutes = Math.round((longestStreak * 7) / 60);

    // Build session summaries
    const sessions = daySessions.map(s => {
      const apps = JSON.parse(s.apps || '[]') as string[];
      const durationMs = (s.ended_at || Date.now()) - s.started_at;
      return {
        topic: s.topic,
        durationMinutes: Math.round(durationMs / 60000),
        apps,
      };
    });

    // Generate AI takeaways
    const aiTakeaways = await this.generateTakeaways(
      totalActiveMinutes,
      appBreakdown,
      contextSwitches,
      focusScore,
      sessions
    );

    return {
      date: targetDate!,
      totalActiveMinutes,
      appBreakdown,
      sessionCount: daySessions.length,
      sessions,
      focusScore,
      contextSwitches,
      longestFocusMinutes,
      suggestions: suggestionStats,
      aiTakeaways,
    };
  }

  /**
   * Get app usage stats for a time range.
   */
  getAppUsage(startTime: number, endTime: number): AppUsageStat[] {
    return getAppUsageStats(startTime, endTime);
  }

  /**
   * Get recent session history.
   */
  getSessionHistory(limit: number = 20): SessionSummary[] {
    const rows = getRecentSessions(limit);
    return rows.map(r => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      topic: r.topic,
      apps: JSON.parse(r.apps || '[]') as string[],
      projectContext: r.project_context,
      captureCount: r.capture_count,
      summary: r.summary,
    }));
  }

  /**
   * Get live context snapshot.
   */
  getLiveContext(tracker: ContextTracker, isRunning: boolean): LiveContext {
    const ctx = tracker.getCurrentContext();
    const session = tracker.getCurrentSession();

    // Recent unique apps from last 10 minutes
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    let recentApps: string[] = [];
    try {
      const stats = getAppUsageStats(tenMinAgo, Date.now());
      recentApps = stats.map(s => s.app);
    } catch { /* ignore */ }

    // Counts
    let capturesLastHour = 0;
    let suggestionsToday = 0;
    try {
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      capturesLastHour = getCaptureCountSince(oneHourAgo);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      suggestionsToday = getSuggestionCountSince(todayStart.getTime());
    } catch { /* ignore */ }

    return {
      currentApp: ctx?.appName ?? null,
      currentWindow: ctx?.windowTitle ?? null,
      currentSession: session ? {
        id: session.id,
        topic: session.topic,
        durationMs: Date.now() - session.startedAt,
      } : null,
      recentApps,
      capturesLastHour,
      suggestionsToday,
      isRunning,
    };
  }

  /**
   * Generate a weekly productivity report with trends.
   * @param weekStart — Monday date 'YYYY-MM-DD', or undefined for current week
   */
  async generateWeeklyReport(weekStart?: string): Promise<WeeklyReport> {
    const monday = weekStart ? new Date(weekStart + 'T00:00:00') : this.getMondayOfWeek(new Date());
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);

    const weekStartStr = monday.toISOString().split('T')[0];
    const weekEndStr = sunday.toISOString().split('T')[0];

    // Previous week for trend comparison
    const prevMonday = new Date(monday);
    prevMonday.setDate(prevMonday.getDate() - 7);

    // Build daily breakdown
    const dailyBreakdown: WeeklyReport['dailyBreakdown'] = [];
    let totalMinutes = 0;
    let totalFocus = 0;
    let totalSwitches = 0;
    let totalSessions = 0;
    let daysWithData = 0;

    for (let d = 0; d < 7; d++) {
      const day = new Date(monday);
      day.setDate(day.getDate() + d);
      const dateStr = day.toISOString().split('T')[0];
      const dayStart = new Date(dateStr + 'T00:00:00').getTime();
      const dayEnd = new Date(dateStr + 'T23:59:59.999').getTime();

      const captures = getCapturesInRange(dayStart, dayEnd);
      const activeMinutes = Math.round((captures.length * 7) / 60);

      const contextSwitches = captures.filter((c, i) =>
        i > 0 && c.app_name !== captures[i - 1]!.app_name
      ).length;

      const activeHours = Math.max(activeMinutes / 60, 0.1);
      const switchesPerHour = contextSwitches / activeHours;
      const focusScore = captures.length > 0
        ? Math.max(0, Math.min(100, Math.round(100 * Math.exp(-switchesPerHour / 15))))
        : 0;

      const allSessions = getRecentSessions(100);
      const sessionCount = allSessions.filter(s => s.started_at >= dayStart && s.started_at <= dayEnd).length;

      dailyBreakdown.push({ date: dateStr!, activeMinutes, focusScore, contextSwitches, sessionCount });
      totalMinutes += activeMinutes;
      totalFocus += focusScore;
      totalSwitches += contextSwitches;
      totalSessions += sessionCount;
      if (activeMinutes > 0) daysWithData++;
    }

    const avgDailyMinutes = daysWithData > 0 ? Math.round(totalMinutes / daysWithData) : 0;
    const avgFocusScore = daysWithData > 0 ? Math.round(totalFocus / daysWithData) : 0;

    // Get aggregated top apps for the week
    const weekStartMs = monday.getTime();
    const weekEndMs = sunday.getTime() + 24 * 60 * 60 * 1000 - 1;
    const topApps = getAppUsageStats(weekStartMs, weekEndMs);

    // Compare with previous week for trends
    const prevWeekStartMs = prevMonday.getTime();
    const prevWeekEndMs = weekStartMs - 1;
    let prevTotalMinutes = 0;
    let prevTotalFocus = 0;
    let prevTotalSwitches = 0;
    let prevDaysWithData = 0;

    for (let d = 0; d < 7; d++) {
      const day = new Date(prevMonday);
      day.setDate(day.getDate() + d);
      const dateStr = day.toISOString().split('T')[0];
      const dayStart = new Date(dateStr + 'T00:00:00').getTime();
      const dayEnd = new Date(dateStr + 'T23:59:59.999').getTime();
      const captures = getCapturesInRange(dayStart, dayEnd);
      const mins = Math.round((captures.length * 7) / 60);
      const switches = captures.filter((c, i) => i > 0 && c.app_name !== captures[i - 1]!.app_name).length;
      const hrs = Math.max(mins / 60, 0.1);
      const focus = captures.length > 0
        ? Math.max(0, Math.min(100, Math.round(100 * Math.exp(-(switches / hrs) / 15))))
        : 0;
      prevTotalMinutes += mins;
      prevTotalFocus += focus;
      prevTotalSwitches += switches;
      if (mins > 0) prevDaysWithData++;
    }

    const prevAvgMinutes = prevDaysWithData > 0 ? prevTotalMinutes / prevDaysWithData : 0;
    const prevAvgFocus = prevDaysWithData > 0 ? prevTotalFocus / prevDaysWithData : 0;
    const prevAvgSwitches = prevDaysWithData > 0 ? prevTotalSwitches / prevDaysWithData : 0;
    const currAvgSwitches = daysWithData > 0 ? totalSwitches / daysWithData : 0;

    const trendOf = (curr: number, prev: number): 'up' | 'down' | 'stable' => {
      if (prev === 0) return curr > 0 ? 'up' : 'stable';
      const change = (curr - prev) / prev;
      if (change > 0.1) return 'up';
      if (change < -0.1) return 'down';
      return 'stable';
    };

    const trends: WeeklyReport['trends'] = {
      activeTime: trendOf(avgDailyMinutes, prevAvgMinutes),
      focusScore: trendOf(avgFocusScore, prevAvgFocus),
      contextSwitches: trendOf(currAvgSwitches, prevAvgSwitches),
    };

    // Generate AI weekly insights
    const aiInsights = await this.generateWeeklyInsights(
      totalMinutes, avgDailyMinutes, avgFocusScore, topApps, trends, dailyBreakdown
    );

    return {
      weekStart: weekStartStr!,
      weekEnd: weekEndStr!,
      totalActiveMinutes: totalMinutes,
      avgDailyMinutes,
      avgFocusScore,
      topApps,
      dailyBreakdown,
      trends,
      aiInsights,
    };
  }

  /**
   * Get behavioral insights comparing recent activity to previous period.
   */
  getBehavioralInsights(days: number = 7): BehavioralInsight[] {
    const insights: BehavioralInsight[] = [];
    const now = Date.now();
    const periodMs = days * 24 * 60 * 60 * 1000;
    const currentStart = now - periodMs;
    const prevStart = currentStart - periodMs;

    // Current period stats
    const currentCaptures = getCapturesInRange(currentStart, now);
    const prevCaptures = getCapturesInRange(prevStart, currentStart);

    const currentMinutes = Math.round((currentCaptures.length * 7) / 60);
    const prevMinutes = Math.round((prevCaptures.length * 7) / 60);

    // Active time comparison
    if (currentMinutes > 0 || prevMinutes > 0) {
      const delta = currentMinutes - prevMinutes;
      const direction = delta > 0 ? 'more' : delta < 0 ? 'less' : 'the same';
      insights.push({
        id: generateId(),
        type: 'active_time',
        title: 'Active Time',
        body: `You were active for ${currentMinutes} minutes over the last ${days} days — ${Math.abs(delta)} minutes ${direction} than the previous period.`,
        metric: { name: 'Active Minutes', current: currentMinutes, previous: prevMinutes, unit: 'min' },
      });
    }

    // Focus comparison
    const computeFocus = (captures: Array<{ app_name: string | null }>) => {
      if (captures.length === 0) return 0;
      const switches = captures.filter((c, i) => i > 0 && c.app_name !== captures[i - 1]!.app_name).length;
      const hours = Math.max((captures.length * 7) / 3600, 0.1);
      return Math.max(0, Math.min(100, Math.round(100 * Math.exp(-(switches / hours) / 15))));
    };

    const currentFocus = computeFocus(currentCaptures);
    const prevFocus = computeFocus(prevCaptures);

    if (currentCaptures.length > 0) {
      insights.push({
        id: generateId(),
        type: 'focus',
        title: 'Focus Score',
        body: currentFocus >= prevFocus
          ? `Focus score is ${currentFocus}/100 — ${currentFocus > prevFocus ? 'improved' : 'holding steady'} from ${prevFocus}/100.`
          : `Focus score dropped to ${currentFocus}/100 from ${prevFocus}/100. Consider reducing context switches.`,
        metric: { name: 'Focus Score', current: currentFocus, previous: prevFocus, unit: '/100' },
      });
    }

    // Top app identification
    const currentApps = getAppUsageStats(currentStart, now);
    if (currentApps.length > 0) {
      const topApp = currentApps[0]!;
      insights.push({
        id: generateId(),
        type: 'top_app',
        title: `Top App: ${topApp.app}`,
        body: `${topApp.app} dominated with ${topApp.minutes} minutes (${topApp.percentage}% of active time).`,
      });
    }

    return insights;
  }

  private getMondayOfWeek(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private async generateWeeklyInsights(
    totalMinutes: number,
    avgDailyMinutes: number,
    avgFocusScore: number,
    topApps: AppUsageStat[],
    trends: WeeklyReport['trends'],
    dailyBreakdown: WeeklyReport['dailyBreakdown']
  ): Promise<string[]> {
    if (totalMinutes < 10) return ['Not enough data for weekly insights.'];

    const topAppsStr = topApps.slice(0, 5).map(a => `${a.app}: ${a.minutes}min`).join(', ');
    const trendStr = `Active time: ${trends.activeTime}, Focus: ${trends.focusScore}, Switches: ${trends.contextSwitches}`;
    const bestDay = [...dailyBreakdown].sort((a, b) => b.focusScore - a.focusScore)[0];

    try {
      const response = await this.llm.chatTier(
        'low',
        'awareness_weekly_insights',
        [{
          role: 'user',
          content: `Analyze this weekly productivity data and give 3-4 brief insights:

Total active time: ${totalMinutes} minutes (avg ${avgDailyMinutes}/day)
Average focus score: ${avgFocusScore}/100
Top apps: ${topAppsStr}
Trends vs last week: ${trendStr}
Best focus day: ${bestDay?.date} (${bestDay?.focusScore}/100)

Give actionable insights as a JSON array of strings.`,
        }],
        { max_tokens: 300 }
      );

      try {
        const match = response.content.match(/\[[\s\S]*\]/);
        if (match) return JSON.parse(match[0]) as string[];
      } catch { /* parse failure */ }

      return [response.content.slice(0, 200)];
    } catch (err) {
      console.error('[Analytics] Weekly insight generation failed:', err instanceof Error ? err.message : err);
      return [`${totalMinutes} minutes active this week. Avg focus: ${avgFocusScore}/100.`];
    }
  }

  /**
   * Generate AI takeaways from daily stats.
   */
  private async generateTakeaways(
    totalMinutes: number,
    appBreakdown: AppUsageStat[],
    contextSwitches: number,
    focusScore: number,
    sessions: Array<{ topic: string | null; durationMinutes: number; apps: string[] }>
  ): Promise<string[]> {
    if (totalMinutes < 5) return ['Not enough activity data for insights.'];

    const topApps = appBreakdown.slice(0, 5).map(a => `${a.app}: ${a.minutes}min (${a.percentage}%)`).join(', ');
    const sessionSummary = sessions.slice(0, 5).map(s =>
      `${s.topic || 'Unnamed'}: ${s.durationMinutes}min in ${s.apps.join(', ')}`
    ).join('; ');

    try {
      const response = await this.llm.chatTier(
        'low',
        'awareness_daily_takeaways',
        [{
          role: 'user',
          content: `Analyze this daily productivity data and give 3-5 brief takeaways:

Active time: ${totalMinutes} minutes
Focus score: ${focusScore}/100
Context switches: ${contextSwitches}
Top apps: ${topApps}
Sessions: ${sessionSummary}

Give actionable insights as a JSON array of strings. Example: ["You spent 40% of time in VS Code — focused coding session!", "High context switching after 3pm — consider blocking distracting apps"]`,
        }],
        { max_tokens: 300 }
      );

      try {
        const match = response.content.match(/\[[\s\S]*\]/);
        if (match) {
          return JSON.parse(match[0]) as string[];
        }
      } catch { /* parse failure */ }

      return [response.content.slice(0, 200)];
    } catch (err) {
      console.error('[Analytics] Takeaway generation failed:', err instanceof Error ? err.message : err);
      return [`Active for ${totalMinutes} minutes. Focus score: ${focusScore}/100.`];
    }
  }
}
