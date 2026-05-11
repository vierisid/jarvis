/**
 * Awareness Engine — Shared Types
 *
 * Type definitions for the continuous screen awareness system (M13).
 */

// ── Capture Layer ──

// ── Context ──

export type ScreenContext = {
  captureId: string;
  timestamp: number;
  appName: string;
  windowTitle: string;
  url: string | null;
  filePath: string | null;
  ocrText: string;
  sessionId: string;
  isSignificantChange: boolean;
};

// ── Events ──

export type AwarenessEventType =
  | 'context_changed'
  | 'error_detected'
  | 'stuck_detected'
  | 'struggle_detected'
  | 'session_started'
  | 'session_ended'
  | 'suggestion_ready';

export type AwarenessEvent = {
  type: AwarenessEventType;
  data: Record<string, unknown>;
  timestamp: number;
};

// ── Suggestions ──

export type SuggestionType =
  | 'error'
  | 'stuck'
  | 'struggle'
  | 'automation'
  | 'knowledge'
  | 'schedule'
  | 'break'
  | 'general';

export type Suggestion = {
  id: string;
  type: SuggestionType;
  title: string;
  body: string;
  triggerCaptureId: string;
  context?: Record<string, unknown>;
};

// ── Sessions ──

export type SessionSummary = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  topic: string | null;
  apps: string[];
  projectContext: string | null;
  captureCount: number;
  summary: string | null;
};

// ── Analytics ──

export type AppUsageStat = {
  app: string;
  minutes: number;
  percentage: number;
  captureCount: number;
};

export type DailyReport = {
  date: string;
  totalActiveMinutes: number;
  appBreakdown: AppUsageStat[];
  sessionCount: number;
  sessions: Array<{ topic: string | null; durationMinutes: number; apps: string[] }>;
  focusScore: number;         // 0-100
  contextSwitches: number;
  longestFocusMinutes: number;
  suggestions: { total: number; actedOn: number };
  aiTakeaways: string[];
};

export type LiveContext = {
  currentApp: string | null;
  currentWindow: string | null;
  currentSession: { id: string; topic: string | null; durationMs: number } | null;
  recentApps: string[];
  capturesLastHour: number;
  suggestionsToday: number;
  isRunning: boolean;
};

// ── Weekly Report & Insights ──

export type WeeklyReport = {
  weekStart: string;        // YYYY-MM-DD (Monday)
  weekEnd: string;          // YYYY-MM-DD (Sunday)
  totalActiveMinutes: number;
  avgDailyMinutes: number;
  avgFocusScore: number;
  topApps: AppUsageStat[];
  dailyBreakdown: Array<{
    date: string;
    activeMinutes: number;
    focusScore: number;
    contextSwitches: number;
    sessionCount: number;
  }>;
  trends: {
    activeTime: 'up' | 'down' | 'stable';
    focusScore: 'up' | 'down' | 'stable';
    contextSwitches: 'up' | 'down' | 'stable';
  };
  aiInsights: string[];
};

export type BehavioralInsight = {
  id: string;
  type: 'active_time' | 'focus' | 'top_app' | 'pattern' | 'general';
  title: string;
  body: string;
  metric?: {
    name: string;
    current: number;
    previous: number;
    unit: string;
  };
};

// ── Database Row Types ──

export type ScreenCaptureRow = {
  id: string;
  timestamp: number;
  session_id: string | null;
  sidecar_id: string | null;
  image_path: string | null;
  pixel_change_pct: number;
  ocr_text: string | null;
  app_name: string | null;
  window_title: string | null;
  url: string | null;
  file_path: string | null;
  retention_tier: 'full' | 'key_moment' | 'metadata_only';
  created_at: number;
};

export type SessionRow = {
  id: string;
  started_at: number;
  ended_at: number | null;
  topic: string | null;
  apps: string;             // JSON array
  project_context: string | null;
  action_types: string;     // JSON array
  entity_links: string;     // JSON array
  summary: string | null;
  capture_count: number;
  created_at: number;
};

export type SuggestionRow = {
  id: string;
  type: SuggestionType;
  trigger_capture_id: string | null;
  title: string;
  body: string;
  context: string | null;   // JSON
  delivered: number;
  delivered_at: number | null;
  delivery_channel: string | null;
  dismissed: number;
  acted_on: number;
  created_at: number;
};
