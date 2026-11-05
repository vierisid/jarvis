#!/usr/bin/env bun
/**
 * Measure routine detection on this machine's own stored screen captures
 * (#1068). Read-only; prints counts only (see
 * src/awareness/evaluation/routine-field-measure.ts), never screen text.
 *
 *   bun run scripts/measure-routine-ocr.ts [path/to/jarvis.db]
 *
 * The database defaults to $JARVIS_HOME/jarvis.db, else ~/.jarvis/jarvis.db.
 * Captures exist only where awareness is on, and only for the retention the
 * install keeps (awareness.retention, 1 hour by default); the last 14 days
 * (the detection window) are measured. See docs/opportunity-routines.md.
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPPORTUNITY_WINDOW_MS } from '../src/awareness/routine-episodes.ts';
import { measureRoutineCaptures } from '../src/awareness/evaluation/routine-field-measure.ts';
import { MAX_ROUTINE_OCR_CHARS } from '../src/awareness/routine-signals.ts';

const path = process.argv[2] ?? join(process.env.JARVIS_HOME ?? join(homedir(), '.jarvis'), 'jarvis.db');
let db: Database;
try {
  db = new Database(path, { readonly: true });
} catch (err) {
  console.error(`Cannot open ${path} read-only (${err instanceof Error ? err.message : err}). Pass the database path if you set daemon.db_path.`);
  process.exit(1);
}
type Row = {
  id: string; timestamp: number; app_name: string | null; window_title: string | null;
  ocr_text: string | null; sidecar_id: string | null; retention_tier: string;
};
try {
  const now = Date.now();
  const captures = [];
  // Row by row: with retention raised for a measurement, the window can hold
  // tens of thousands of captures of up to 20,000 OCR characters each.
  for (const r of db.query(`SELECT id, timestamp, app_name, window_title, ocr_text, sidecar_id, retention_tier
    FROM screen_captures WHERE timestamp >= ? AND timestamp <= ?`).iterate(now - OPPORTUNITY_WINDOW_MS, now) as IterableIterator<Row>) {
    // The bounds classifyJobSignals applies; longer OCR is counted as oversize, not kept.
    const ocrText = r.ocr_text && r.ocr_text.length > MAX_ROUTINE_OCR_CHARS ? r.ocr_text.slice(0, MAX_ROUTINE_OCR_CHARS + 1) : r.ocr_text;
    captures.push({ captureId: r.id, timestamp: r.timestamp, app: r.app_name, windowTitle: r.window_title,
      ocrText, sidecarId: r.sidecar_id, excluded: r.retention_tier === 'metadata_only' });
  }
  console.log(JSON.stringify(measureRoutineCaptures(captures, now), null, 2));
} finally {
  db.close();
}
