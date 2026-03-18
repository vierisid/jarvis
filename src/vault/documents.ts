/**
 * Vault Documents — CRUD for vault-stored documents
 *
 * Documents are files JARVIS creates (reports, plans, analyses, etc.)
 * stored in the vault SQLite database instead of on disk.
 */

import { getDb, generateId } from './schema.ts';

/** Escape SQL LIKE wildcard characters in user input */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

export type DocumentFormat = 'markdown' | 'plain' | 'html' | 'json' | 'csv' | 'code';

export type Document = {
  id: string;
  title: string;
  body: string;
  format: DocumentFormat;
  tags: string[];
  created_at: number;
  updated_at: number;
};

type DocumentRow = Omit<Document, 'tags'> & { tags: string | null };

function parseRow(row: DocumentRow): Document {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

export function createDocument(title: string, body: string, opts?: {
  format?: DocumentFormat;
  tags?: string[];
}): Document {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  db.prepare(
    `INSERT INTO documents (id, title, body, format, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    body,
    opts?.format ?? 'markdown',
    opts?.tags ? JSON.stringify(opts.tags) : null,
    now,
    now,
  );

  return {
    id, title, body,
    format: opts?.format ?? 'markdown',
    tags: opts?.tags ?? [],
    created_at: now,
    updated_at: now,
  };
}

export function getDocument(id: string): Document | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | null;
  return row ? parseRow(row) : null;
}

export function findDocuments(query?: {
  format?: DocumentFormat;
  tag?: string;
  search?: string;
}): Document[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query?.format) {
    conditions.push('format = ?');
    params.push(query.format);
  }
  if (query?.tag) {
    conditions.push("tags LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(query.tag)}"%`);
  }
  if (query?.search) {
    conditions.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    params.push(`%${escapeLike(query.search)}%`, `%${escapeLike(query.search)}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM documents ${where} ORDER BY updated_at DESC`
  ).all(...params as any[]) as DocumentRow[];

  return rows.map(parseRow);
}

export function updateDocument(id: string, updates: {
  title?: string;
  body?: string;
  format?: DocumentFormat;
  tags?: string[];
}): Document | null {
  const db = getDb();
  const existing = getDocument(id);
  if (!existing) return null;

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];

  if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
  if (updates.body !== undefined) { sets.push('body = ?'); params.push(updates.body); }
  if (updates.format !== undefined) { sets.push('format = ?'); params.push(updates.format); }
  if (updates.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }

  params.push(id);
  db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params as any[]);

  return getDocument(id);
}

export function deleteDocument(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  return result.changes > 0;
}
