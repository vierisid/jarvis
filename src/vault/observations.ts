import { getDb, generateId } from './schema.ts';

export type ObservationType =
  | 'file_change'
  | 'notification'
  | 'clipboard'
  | 'app_activity'
  | 'calendar'
  | 'email'
  | 'browser'
  | 'process'
  | 'screen_capture';

export type Observation = {
  id: string;
  type: ObservationType;
  data: Record<string, unknown>;
  processed: boolean;
  created_at: number;
};

/**
 * Normalized presentation shape for an observation, used by surfaces that
 * need to render observations without knowing each type's data schema.
 * Computed by `summarizeObservation()`.
 */
export type ObservationSummary = {
  id: string;
  type: ObservationType;
  title: string;
  summary: string;
  created_at: number;
};

/**
 * Project the type-dependent `data` payload of an Observation into a stable
 * `{ title, summary }` pair suitable for cards, palette rows, log lists.
 *
 * Falls back to a generic title/summary when the observation type doesn't
 * have a known shape — never throws, never returns null.
 */
export function summarizeObservation(o: Observation): ObservationSummary {
  const d = o.data ?? {};
  const str = (k: string): string | undefined => {
    const v = (d as Record<string, unknown>)[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  let title = humanizeType(o.type);
  let summary = '';

  switch (o.type) {
    case 'file_change': {
      const path = str('path') ?? str('file');
      const op = str('op') ?? str('action') ?? 'changed';
      if (path) title = `${op}: ${path}`;
      summary = str('detail') ?? str('description') ?? '';
      break;
    }
    case 'notification': {
      title = str('title') ?? title;
      summary = str('body') ?? str('message') ?? str('text') ?? '';
      break;
    }
    case 'clipboard': {
      title = 'Clipboard';
      summary = (str('text') ?? '').slice(0, 200);
      break;
    }
    case 'app_activity': {
      const app = str('app') ?? str('name');
      const action = str('action') ?? 'active';
      title = app ? `${app} · ${action}` : title;
      summary = str('detail') ?? str('description') ?? '';
      break;
    }
    case 'calendar': {
      title = str('title') ?? str('summary') ?? title;
      summary = str('description') ?? str('location') ?? '';
      break;
    }
    case 'email': {
      title = str('subject') ?? title;
      const from = str('from');
      summary = from ? `From ${from}` : (str('preview') ?? '');
      break;
    }
    case 'browser': {
      title = str('title') ?? str('url') ?? title;
      summary = str('url') ?? '';
      break;
    }
    case 'process': {
      const name = str('name') ?? str('process');
      const action = str('action') ?? 'event';
      title = name ? `${name} · ${action}` : title;
      summary = str('command') ?? str('detail') ?? '';
      break;
    }
    case 'screen_capture': {
      title = 'Screen capture';
      summary = str('window') ?? str('app') ?? '';
      break;
    }
    default: {
      summary = str('description') ?? str('summary') ?? str('text') ?? '';
    }
  }

  return {
    id: o.id,
    type: o.type,
    title,
    summary: summary.length > 240 ? summary.slice(0, 237) + '…' : summary,
    created_at: o.created_at,
  };
}

/**
 * One-line, content-free description of an observation for an agent prompt.
 *
 * Unlike summarizeObservation (dashboard cards), this never includes the
 * body of what was observed: no OCR text, no clipboard contents, no email
 * snippet, no notification body. Those are attacker-writable and belong in
 * a tool result the model asks for, not in the system prompt. Titles and
 * subjects are kept because the agent needs them to know what happened;
 * the caller wraps the whole list as untrusted content.
 */
export function describeObservationForPrompt(o: Observation): string {
  const d = (o.data ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const v = d[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const clip = (s: string, n = 120): string => (s.length > n ? s.slice(0, n - 3) + '...' : s);

  switch (o.type) {
    case 'screen_capture': {
      const app = str('appName') ?? str('app');
      const win = str('windowTitle') ?? str('window');
      return `screen: ${app ?? 'unknown app'}${win ? ` / ${clip(win)}` : ''}`;
    }
    case 'clipboard': {
      const text = str('text') ?? str('content');
      const len = typeof d.length === 'number' ? d.length : (text?.length ?? 0);
      return `clipboard changed (${len} chars)`;
    }
    case 'email': {
      const from = str('from');
      const subject = str('subject');
      return `email${from ? ` from ${clip(from, 60)}` : ''}${subject ? `: "${clip(subject)}"` : ''}`;
    }
    case 'notification': {
      const app = str('app') ?? str('appName') ?? str('source');
      const title = str('title') ?? str('summary');
      return `${app ?? 'system'} notification${title ? `: "${clip(title)}"` : ''}`;
    }
    case 'file_change': {
      const path = str('path') ?? str('file');
      // The sidecar's file watcher sends `eventType`; older producers used op/action.
      const op = str('eventType') ?? str('op') ?? str('action') ?? str('changeType') ?? 'changed';
      return `file ${op}${path ? `: ${clip(path)}` : ''}`;
    }
    case 'process': {
      const name = str('name') ?? str('process');
      const action = str('action') ?? 'event';
      return `process ${action}${name ? `: ${clip(name, 60)}` : ''}`;
    }
    case 'calendar': {
      const title = str('title') ?? str('summary');
      return `calendar${title ? `: "${clip(title)}"` : ''}`;
    }
    case 'browser': {
      const title = str('title');
      const url = str('url');
      return `browser: ${title ? clip(title) : ''}${url ? ` (${clip(url, 80)})` : ''}`.trim();
    }
    case 'app_activity': {
      const app = str('app') ?? str('name');
      const action = str('action') ?? 'active';
      return `app ${action}${app ? `: ${clip(app, 60)}` : ''}`;
    }
    default:
      return humanizeType(o.type);
  }
}

function humanizeType(t: ObservationType): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

type ObservationRow = {
  id: string;
  type: ObservationType;
  data: string;
  processed: number;
  created_at: number;
};

/**
 * Parse observation row from database, deserializing JSON fields
 */
function parseObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    type: row.type,
    data: JSON.parse(row.data),
    processed: row.processed === 1,
    created_at: row.created_at,
  };
}

/**
 * Create a new observation
 */
export function createObservation(
  type: ObservationType,
  data: Record<string, unknown>
): Observation {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  const stmt = db.prepare(
    'INSERT INTO observations (id, type, data, processed, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  stmt.run(id, type, JSON.stringify(data), 0, now);

  return {
    id,
    type,
    data,
    processed: false,
    created_at: now,
  };
}

/**
 * Get unprocessed observations
 */
export function getUnprocessed(limit: number = 100): Observation[] {
  const db = getDb();
  const stmt = db.prepare(
    'SELECT * FROM observations WHERE processed = 0 ORDER BY created_at ASC LIMIT ?'
  );
  const rows = stmt.all(limit) as ObservationRow[];

  return rows.map(parseObservation);
}

/**
 * Mark an observation as processed
 */
export function markProcessed(id: string): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE observations SET processed = 1 WHERE id = ?');
  stmt.run(id);
}

/**
 * Get recent observations, optionally filtered by type
 */
export function getRecentObservations(
  type?: ObservationType,
  limit: number = 50
): Observation[] {
  const db = getDb();

  let query = 'SELECT * FROM observations';
  const params: unknown[] = [];

  if (type) {
    query += ' WHERE type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  const rows = stmt.all(...params as any[]) as ObservationRow[];

  return rows.map(parseObservation);
}
