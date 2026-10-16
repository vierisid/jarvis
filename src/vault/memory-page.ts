import { getDb } from './schema';
import { getEntity } from './entities';
import { getFact } from './facts';
import { getRelationship } from './relationships';

const readers = { entities: getEntity, facts: getFact, relationships: getRelationship };
export type MemoryKind = keyof typeof readers;
export function readMemoryPage(kind: string, cursor = '') {
  if (!Object.hasOwn(readers, kind) || cursor.length > 100) throw new Error('Invalid memory page');
  const table = kind as MemoryKind;
  // Fixed table allowlist, keyset pagination over the primary key. No full-table hydration.
  const rows = getDb().query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE id > ?
    ${table === 'facts' ? "AND status != 'superseded'" : ''} ORDER BY id LIMIT 101`).all(cursor);
  return { items: rows.slice(0, 100).flatMap(row => { const item = readers[table](row.id); return item ? [item] : []; }),
    nextCursor: rows.length > 100 ? rows[99]!.id : null };
}
export function memoryPageResponse(req: Request, json: (data: unknown, status?: number) => Response = (data, status = 200) => Response.json(data, { status })): Response {
  const params = new URL(req.url).searchParams;
  try { return json(readMemoryPage(params.get('kind') ?? '', params.get('cursor') ?? '')); }
  catch (error) {
    if (error instanceof Error && error.message === 'Invalid memory page') return json({ error: error.message }, 400);
    throw error;
  }
}
