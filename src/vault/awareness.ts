/**
 * Vault — Awareness CRUD
 *
 * Database operations for screen_captures, awareness_sessions, and awareness_suggestions tables.
 * Follows the same patterns as observations.ts and commitments.ts.
 */

import { getDb, generateId } from './schema.ts';
import type {
  ScreenCaptureRow,
  SessionRow,
  SuggestionRow,
  SuggestionType,
  AppUsageStat,
} from '../awareness/types.ts';

// ── Screen Captures ──

export function createCapture(data: {
  timestamp: number;
  sessionId?: string;
  sidecarId?: string;
  imagePath?: string;
  pixelChangePct: number;
  ocrText?: string;
  appName?: string;
  windowTitle?: string;
  url?: string;
  filePath?: string;
  retentionTier?: 'full' | 'key_moment' | 'metadata_only';
}): ScreenCaptureRow {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO screen_captures
      (id, timestamp, session_id, sidecar_id, image_path, pixel_change_pct,
       ocr_text, app_name, window_title, url, file_path, retention_tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.timestamp,
    data.sessionId ?? null,
    data.sidecarId ?? null,
    data.imagePath ?? null,
    data.pixelChangePct,
    data.ocrText ?? null,
    data.appName ?? null,
    data.windowTitle ?? null,
    data.url ?? null,
    data.filePath ?? null,
    data.retentionTier ?? 'full',
    now,
  );

  return {
    id,
    timestamp: data.timestamp,
    session_id: data.sessionId ?? null,
    sidecar_id: data.sidecarId ?? null,
    image_path: data.imagePath ?? null,
    pixel_change_pct: data.pixelChangePct,
    ocr_text: data.ocrText ?? null,
    app_name: data.appName ?? null,
    window_title: data.windowTitle ?? null,
    url: data.url ?? null,
    file_path: data.filePath ?? null,
    retention_tier: data.retentionTier ?? 'full',
    created_at: now,
  };
}

export function getCapture(id: string): ScreenCaptureRow | null {
  const db = getDb();
  return db.prepare('SELECT * FROM screen_captures WHERE id = ?').get(id) as ScreenCaptureRow | null;
}

export function getRecentCaptures(limit: number = 50, appName?: string): ScreenCaptureRow[] {
  const db = getDb();
  if (appName) {
    return db.prepare(
      'SELECT * FROM screen_captures WHERE app_name = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(appName, limit) as ScreenCaptureRow[];
  }
  return db.prepare(
    'SELECT * FROM screen_captures ORDER BY timestamp DESC LIMIT ?'
  ).all(limit) as ScreenCaptureRow[];
}

export function getCapturesInRange(startTime: number, endTime: number): ScreenCaptureRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM screen_captures WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
  ).all(startTime, endTime) as ScreenCaptureRow[];
}

export function getAppUsageStats(startTime: number, endTime: number): AppUsageStat[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT app_name, COUNT(*) as capture_count
    FROM screen_captures
    WHERE timestamp >= ? AND timestamp <= ? AND app_name IS NOT NULL
    GROUP BY app_name
    ORDER BY capture_count DESC
  `).all(startTime, endTime) as Array<{ app_name: string; capture_count: number }>;

  const totalCaptures = rows.reduce((sum, r) => sum + r.capture_count, 0);

  return rows.map(r => ({
    app: r.app_name,
    captureCount: r.capture_count,
    minutes: Math.round((r.capture_count * 7) / 60),  // ~7s per capture
    percentage: totalCaptures > 0 ? Math.round((r.capture_count / totalCaptures) * 100) : 0,
  }));
}

export function getCaptureCountSince(timestamp: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM screen_captures WHERE timestamp >= ?'
  ).get(timestamp) as { count: number };
  return row.count;
}

export function updateCaptureRetention(id: string, tier: 'full' | 'key_moment' | 'metadata_only'): void {
  const db = getDb();
  db.prepare('UPDATE screen_captures SET retention_tier = ? WHERE id = ?').run(tier, id);
}

export function deleteCapturesBefore(timestamp: number, retentionTier: string): number {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM screen_captures WHERE timestamp < ? AND retention_tier = ?'
  ).run(timestamp, retentionTier);
  return result.changes;
}

export function updateCaptureOcrText(id: string, ocrText: string): void {
  const db = getDb();
  db.prepare('UPDATE screen_captures SET ocr_text = ? WHERE id = ?').run(ocrText, id);
}

export function getCapturesForSession(sessionId: string, limit: number = 50): ScreenCaptureRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM screen_captures WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(sessionId, limit) as ScreenCaptureRow[];
}

// ── Awareness Sessions ──

export function createSession(data: {
  startedAt: number;
  apps?: string[];
  projectContext?: string;
}): SessionRow {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO awareness_sessions
      (id, started_at, ended_at, topic, apps, project_context, action_types, entity_links, summary, capture_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.startedAt,
    null,
    null,
    JSON.stringify(data.apps ?? []),
    data.projectContext ?? null,
    JSON.stringify([]),
    JSON.stringify([]),
    null,
    0,
    now,
  );

  return {
    id,
    started_at: data.startedAt,
    ended_at: null,
    topic: null,
    apps: JSON.stringify(data.apps ?? []),
    project_context: data.projectContext ?? null,
    action_types: JSON.stringify([]),
    entity_links: JSON.stringify([]),
    summary: null,
    capture_count: 0,
    created_at: now,
  };
}

export function getSession(id: string): SessionRow | null {
  const db = getDb();
  return db.prepare('SELECT * FROM awareness_sessions WHERE id = ?').get(id) as SessionRow | null;
}

export function updateSession(id: string, updates: Partial<{
  ended_at: number | null;
  topic: string | null;
  apps: string[];
  project_context: string | null;
  action_types: string[];
  entity_links: string[];
  summary: string | null;
  capture_count: number;
}>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (updates.ended_at !== undefined) { setClauses.push('ended_at = ?'); params.push(updates.ended_at); }
  if (updates.topic !== undefined) { setClauses.push('topic = ?'); params.push(updates.topic); }
  if (updates.apps !== undefined) { setClauses.push('apps = ?'); params.push(JSON.stringify(updates.apps)); }
  if (updates.project_context !== undefined) { setClauses.push('project_context = ?'); params.push(updates.project_context); }
  if (updates.action_types !== undefined) { setClauses.push('action_types = ?'); params.push(JSON.stringify(updates.action_types)); }
  if (updates.entity_links !== undefined) { setClauses.push('entity_links = ?'); params.push(JSON.stringify(updates.entity_links)); }
  if (updates.summary !== undefined) { setClauses.push('summary = ?'); params.push(updates.summary); }
  if (updates.capture_count !== undefined) { setClauses.push('capture_count = ?'); params.push(updates.capture_count); }

  if (setClauses.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE awareness_sessions SET ${setClauses.join(', ')} WHERE id = ?`).run(...params as any[]);
}

export function endSession(id: string, summary?: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE awareness_sessions SET ended_at = ?, summary = ? WHERE id = ?'
  ).run(Date.now(), summary ?? null, id);
}

export function getRecentSessions(limit: number = 20): SessionRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM awareness_sessions ORDER BY started_at DESC LIMIT ?'
  ).all(limit) as SessionRow[];
}

export function incrementSessionCaptureCount(id: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE awareness_sessions SET capture_count = capture_count + 1 WHERE id = ?'
  ).run(id);
}

// ── Awareness Suggestions ──

export function createSuggestion(data: {
  type: SuggestionType;
  triggerCaptureId?: string;
  title: string;
  body: string;
  context?: Record<string, unknown>;
}): SuggestionRow {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO awareness_suggestions
      (id, type, trigger_capture_id, title, body, context, delivered, delivered_at, delivery_channel, dismissed, acted_on, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.type,
    data.triggerCaptureId ?? null,
    data.title,
    data.body,
    data.context ? JSON.stringify(data.context) : null,
    0, null, null, 0, 0,
    now,
  );

  return {
    id,
    type: data.type,
    trigger_capture_id: data.triggerCaptureId ?? null,
    title: data.title,
    body: data.body,
    context: data.context ? JSON.stringify(data.context) : null,
    delivered: 0,
    delivered_at: null,
    delivery_channel: null,
    dismissed: 0,
    acted_on: 0,
    created_at: now,
  };
}

export function markSuggestionDelivered(id: string, channel: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE awareness_suggestions SET delivered = 1, delivered_at = ?, delivery_channel = ? WHERE id = ?'
  ).run(Date.now(), channel, id);
}

export function markSuggestionDismissed(id: string): void {
  const db = getDb();
  db.prepare('UPDATE awareness_suggestions SET dismissed = 1 WHERE id = ?').run(id);
}

export function markSuggestionActedOn(id: string): void {
  const db = getDb();
  db.prepare('UPDATE awareness_suggestions SET acted_on = 1 WHERE id = ?').run(id);
}

export function getRecentSuggestions(limit: number = 20, type?: SuggestionType): SuggestionRow[] {
  const db = getDb();
  if (type) {
    return db.prepare(
      'SELECT * FROM awareness_suggestions WHERE type = ? ORDER BY created_at DESC LIMIT ?'
    ).all(type, limit) as SuggestionRow[];
  }
  return db.prepare(
    'SELECT * FROM awareness_suggestions ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as SuggestionRow[];
}

export function getSuggestionCountSince(timestamp: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM awareness_suggestions WHERE created_at >= ?'
  ).get(timestamp) as { count: number };
  return row.count;
}

export function getSuggestionStats(startTime: number, endTime: number): { total: number; actedOn: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN acted_on = 1 THEN 1 ELSE 0 END) as acted_on
    FROM awareness_suggestions
    WHERE created_at >= ? AND created_at <= ?
  `).get(startTime, endTime) as { total: number; acted_on: number };
  return { total: row.total, actedOn: row.acted_on ?? 0 };
}
