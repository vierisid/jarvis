#!/usr/bin/env bun
/**
 * List the frequent 2-3 word sequences on this machine's own stored captures
 * that matched a routine source phrase, and on the captures that followed one
 * (#1068). Read-only. Unlike measure-routine-ocr.ts this prints screen words,
 * filtered default-deny (see src/awareness/evaluation/routine-phrase-mining.ts):
 * read the output before sharing it.
 *
 *   bun run scripts/mine-routine-phrases.ts [path/to/jarvis.db] [--out file]
 *     [--min-count 3] [--min-days 2] [--top 40]
 *
 * The database defaults to $JARVIS_HOME/jarvis.db, else ~/.jarvis/jarvis.db.
 * The last 14 days are read. See docs/opportunity-routines.md.
 */
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPPORTUNITY_WINDOW_MS } from '../src/awareness/routine-episodes.ts';
import { DEFAULT_PHRASE_MINING, mineRoutinePhrases, type PhraseMiningOptions } from '../src/awareness/evaluation/routine-phrase-mining.ts';
import { MAX_ROUTINE_OCR_CHARS, type RoutineCapture } from '../src/awareness/routine-signals.ts';

const USAGE = 'usage: bun run scripts/mine-routine-phrases.ts [path/to/jarvis.db] [--out file] [--min-count n] [--min-days n] [--top n]';
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const options: PhraseMiningOptions = { ...DEFAULT_PHRASE_MINING };
let dbPath: string | undefined;
let outPath: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  const value = () => args[++i] ?? fail(`${arg} needs a value\n${USAGE}`);
  const count = (min: number) => {
    const n = Number(value());
    if (!Number.isSafeInteger(n) || n < min) fail(`${arg} must be a whole number of at least ${min}\n${USAGE}`);
    return n;
  };
  if (arg === '--out') outPath = value();
  // Below 2 captures on 2 days the default-deny threshold would let one-off text through.
  else if (arg === '--min-count') options.minCount = count(2);
  else if (arg === '--min-days') options.minDays = count(2);
  else if (arg === '--top') options.top = count(1);
  else if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
  else if (arg.startsWith('-') || dbPath) fail(`unexpected argument ${arg}\n${USAGE}`);
  else dbPath = arg;
}

const path = dbPath ?? join(process.env.JARVIS_HOME ?? join(homedir(), '.jarvis'), 'jarvis.db');
let db: Database;
try {
  db = new Database(path, { readonly: true });
} catch (err) {
  fail(`Cannot open ${path} read-only (${err instanceof Error ? err.message : err}). Pass the database path if you set daemon.db_path.`);
}
type Row = {
  id: string; timestamp: number; app_name: string | null; window_title: string | null;
  ocr_text: string | null; sidecar_id: string | null; retention_tier: string;
};
try {
  const now = Date.now();
  const query = db.query(`SELECT id, timestamp, app_name, window_title, ocr_text, sidecar_id, retention_tier
    FROM screen_captures WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp, id`);
  // Streamed: with retention raised, the window can hold tens of thousands of large captures.
  function* captures(): Generator<RoutineCapture> {
    for (const r of query.iterate(now - OPPORTUNITY_WINDOW_MS, now) as IterableIterator<Row>) {
      // Longer OCR is counted as oversize by the gate, as the classifier does.
      const ocrText = r.ocr_text && r.ocr_text.length > MAX_ROUTINE_OCR_CHARS ? r.ocr_text.slice(0, MAX_ROUTINE_OCR_CHARS + 1) : r.ocr_text;
      yield { captureId: r.id, timestamp: r.timestamp, app: r.app_name, windowTitle: r.window_title,
        ocrText, sidecarId: r.sidecar_id, excluded: r.retention_tier === 'metadata_only' };
    }
  }
  const json = JSON.stringify(mineRoutinePhrases(captures, options), null, 2);
  if (outPath) {
    writeFileSync(outPath, `${json}\n`, { mode: 0o600 });
    console.error(`Wrote ${outPath}. Read it before sharing: it lists words seen on your screens.`);
  } else {
    console.log(json);
  }
} finally {
  db.close();
}
