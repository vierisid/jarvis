import { getDb, generateId } from './schema.ts';

/** Escape SQL LIKE wildcard characters in user input */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

export const CONTENT_STAGES = [
  'idea', 'research', 'outline', 'draft', 'assets', 'review', 'scheduled', 'published',
] as const;

export type ContentStage = typeof CONTENT_STAGES[number];

export const CONTENT_TYPES = [
  'youtube', 'blog', 'twitter', 'instagram', 'tiktok', 'linkedin',
  'podcast', 'newsletter', 'short_form', 'other',
] as const;

export type ContentType = typeof CONTENT_TYPES[number];

export type ContentItem = {
  id: string;
  title: string;
  body: string;
  content_type: ContentType;
  stage: ContentStage;
  tags: string[];
  scheduled_at: number | null;
  published_at: number | null;
  published_url: string | null;
  created_by: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export type ContentStageNote = {
  id: string;
  content_id: string;
  stage: ContentStage;
  note: string;
  author: string;
  created_at: number;
};

export type ContentAttachment = {
  id: string;
  content_id: string;
  filename: string;
  disk_path: string;
  mime_type: string;
  size_bytes: number;
  label: string | null;
  created_at: number;
};

type ContentRow = Omit<ContentItem, 'tags'> & { tags: string | null };

function parseRow(row: ContentRow): ContentItem {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

// --- Content Items CRUD ---

export function createContent(title: string, opts?: {
  body?: string;
  content_type?: ContentType;
  stage?: ContentStage;
  tags?: string[];
  created_by?: string;
}): ContentItem {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO content_items (id, title, body, content_type, stage, tags, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    opts?.body ?? '',
    opts?.content_type ?? 'blog',
    opts?.stage ?? 'idea',
    opts?.tags ? JSON.stringify(opts.tags) : null,
    opts?.created_by ?? 'user',
    now,
    now,
  );

  return {
    id, title,
    body: opts?.body ?? '',
    content_type: (opts?.content_type ?? 'blog') as ContentType,
    stage: (opts?.stage ?? 'idea') as ContentStage,
    tags: opts?.tags ?? [],
    scheduled_at: null,
    published_at: null,
    published_url: null,
    created_by: opts?.created_by ?? 'user',
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };
}

export function getContent(id: string): ContentItem | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM content_items WHERE id = ?').get(id) as ContentRow | null;
  return row ? parseRow(row) : null;
}

export function findContent(query: {
  stage?: ContentStage;
  content_type?: ContentType;
  tag?: string;
}): ContentItem[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.stage) {
    conditions.push('stage = ?');
    params.push(query.stage);
  }
  if (query.content_type) {
    conditions.push('content_type = ?');
    params.push(query.content_type);
  }
  if (query.tag) {
    conditions.push("tags LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(query.tag)}"%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM content_items ${where} ORDER BY sort_order ASC, updated_at DESC`
  ).all(...params as any[]) as ContentRow[];

  return rows.map(parseRow);
}

export function updateContent(id: string, updates: {
  title?: string;
  body?: string;
  content_type?: ContentType;
  stage?: ContentStage;
  tags?: string[];
  scheduled_at?: number | null;
  published_at?: number | null;
  published_url?: string | null;
  sort_order?: number;
}): ContentItem | null {
  const db = getDb();
  const existing = getContent(id);
  if (!existing) return null;

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];

  if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
  if (updates.body !== undefined) { sets.push('body = ?'); params.push(updates.body); }
  if (updates.content_type !== undefined) { sets.push('content_type = ?'); params.push(updates.content_type); }
  if (updates.stage !== undefined) { sets.push('stage = ?'); params.push(updates.stage); }
  if (updates.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }
  if (updates.scheduled_at !== undefined) { sets.push('scheduled_at = ?'); params.push(updates.scheduled_at); }
  if (updates.published_at !== undefined) { sets.push('published_at = ?'); params.push(updates.published_at); }
  if (updates.published_url !== undefined) { sets.push('published_url = ?'); params.push(updates.published_url); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(updates.sort_order); }

  params.push(id);
  db.prepare(`UPDATE content_items SET ${sets.join(', ')} WHERE id = ?`).run(...params as any[]);

  return getContent(id);
}

export function deleteContent(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM content_items WHERE id = ?').run(id);
  return result.changes > 0;
}

export function advanceStage(id: string): ContentItem | null {
  const item = getContent(id);
  if (!item) return null;
  const idx = CONTENT_STAGES.indexOf(item.stage);
  if (idx >= CONTENT_STAGES.length - 1) return null;
  return updateContent(id, { stage: CONTENT_STAGES[idx + 1] });
}

export function regressStage(id: string): ContentItem | null {
  const item = getContent(id);
  if (!item) return null;
  const idx = CONTENT_STAGES.indexOf(item.stage);
  if (idx <= 0) return null;
  return updateContent(id, { stage: CONTENT_STAGES[idx - 1] });
}

// --- Stage Notes ---

export function addStageNote(
  contentId: string,
  stage: ContentStage,
  note: string,
  author: string = 'user'
): ContentStageNote {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    'INSERT INTO content_stage_notes (id, content_id, stage, note, author, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, contentId, stage, note, author, now);

  return { id, content_id: contentId, stage, note, author, created_at: now };
}

export function getStageNotes(contentId: string, stage?: ContentStage): ContentStageNote[] {
  const db = getDb();
  if (stage) {
    return db.prepare(
      'SELECT * FROM content_stage_notes WHERE content_id = ? AND stage = ? ORDER BY created_at ASC'
    ).all(contentId, stage) as ContentStageNote[];
  }
  return db.prepare(
    'SELECT * FROM content_stage_notes WHERE content_id = ? ORDER BY created_at ASC'
  ).all(contentId) as ContentStageNote[];
}

// --- Attachments ---

export function addAttachment(
  contentId: string,
  filename: string,
  diskPath: string,
  mimeType: string,
  sizeBytes: number,
  label?: string
): ContentAttachment {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    'INSERT INTO content_attachments (id, content_id, filename, disk_path, mime_type, size_bytes, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, contentId, filename, diskPath, mimeType, sizeBytes, label ?? null, now);

  return { id, content_id: contentId, filename, disk_path: diskPath, mime_type: mimeType, size_bytes: sizeBytes, label: label ?? null, created_at: now };
}

export function getAttachment(id: string): ContentAttachment | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM content_attachments WHERE id = ?').get(id) as ContentAttachment) ?? null;
}

export function getAttachments(contentId: string): ContentAttachment[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM content_attachments WHERE content_id = ? ORDER BY created_at ASC'
  ).all(contentId) as ContentAttachment[];
}

export function deleteAttachment(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM content_attachments WHERE id = ?').run(id);
  return result.changes > 0;
}
