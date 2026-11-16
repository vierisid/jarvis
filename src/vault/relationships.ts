import { getDb, generateId } from './schema.ts';
import { cleanVaultText, RELATIONSHIP_TYPE_MAX_CHARS } from './input-limits.ts';
import type { Entity } from './entities.ts';

export type Relationship = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  properties: Record<string, unknown> | null;
  created_at: number;
};

type RelationshipRow = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  properties: string | null;
  created_at: number;
};

/**
 * Parse relationship row from database, deserializing JSON fields
 */
function parseRelationship(row: RelationshipRow): Relationship {
  return {
    ...row,
    properties: row.properties ? JSON.parse(row.properties) : null,
  };
}

/**
 * Create a new relationship between entities
 */
export function createRelationship(
  from_id: string,
  to_id: string,
  type: string,
  properties?: Record<string, unknown>
): Relationship {
  type = cleanVaultText(String(type), RELATIONSHIP_TYPE_MAX_CHARS);
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  const stmt = db.prepare(
    'INSERT INTO relationships (id, from_id, to_id, type, properties, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  stmt.run(id, from_id, to_id, type, properties ? JSON.stringify(properties) : null, now);

  return {
    id,
    from_id,
    to_id,
    type,
    properties: properties ?? null,
    created_at: now,
  };
}

/**
 * Get a relationship by ID
 */
export function getRelationship(id: string): Relationship | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM relationships WHERE id = ?');
  const row = stmt.get(id) as RelationshipRow | null;

  if (!row) return null;

  return parseRelationship(row);
}

/**
 * Find relationships matching query criteria
 */
export function findRelationships(query: {
  from_id?: string;
  to_id?: string;
  type?: string;
}): Relationship[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.from_id) {
    conditions.push('from_id = ?');
    params.push(query.from_id);
  }

  if (query.to_id) {
    conditions.push('to_id = ?');
    params.push(query.to_id);
  }

  if (query.type) {
    conditions.push('type = ?');
    params.push(query.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = db.prepare(`SELECT * FROM relationships ${where} ORDER BY created_at DESC`);
  const rows = stmt.all(...params as any[]) as RelationshipRow[];

  return rows.map(parseRelationship);
}

/**
 * Get all relationships for an entity (both incoming and outgoing) with full entity details
 */
export function getEntityRelationships(
  entityId: string
): Array<Relationship & { from_entity: Entity; to_entity: Entity }> {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT
      r.*,
      e1.id as from_entity_id,
      e1.type as from_entity_type,
      e1.name as from_entity_name,
      e1.properties as from_entity_properties,
      e1.created_at as from_entity_created_at,
      e1.updated_at as from_entity_updated_at,
      e1.source as from_entity_source,
      e2.id as to_entity_id,
      e2.type as to_entity_type,
      e2.name as to_entity_name,
      e2.properties as to_entity_properties,
      e2.created_at as to_entity_created_at,
      e2.updated_at as to_entity_updated_at,
      e2.source as to_entity_source
    FROM relationships r
    JOIN entities e1 ON r.from_id = e1.id
    JOIN entities e2 ON r.to_id = e2.id
    WHERE r.from_id = ? OR r.to_id = ?
    ORDER BY r.created_at DESC
  `);

  const rows = stmt.all(entityId, entityId) as any[];

  return rows.map((row) => ({
    id: row.id,
    from_id: row.from_id,
    to_id: row.to_id,
    type: row.type,
    properties: row.properties ? JSON.parse(row.properties) : null,
    created_at: row.created_at,
    from_entity: {
      id: row.from_entity_id,
      type: row.from_entity_type,
      name: row.from_entity_name,
      properties: row.from_entity_properties ? JSON.parse(row.from_entity_properties) : null,
      created_at: row.from_entity_created_at,
      updated_at: row.from_entity_updated_at,
      source: row.from_entity_source,
    },
    to_entity: {
      id: row.to_entity_id,
      type: row.to_entity_type,
      name: row.to_entity_name,
      properties: row.to_entity_properties ? JSON.parse(row.to_entity_properties) : null,
      created_at: row.to_entity_created_at,
      updated_at: row.to_entity_updated_at,
      source: row.to_entity_source,
    },
  }));
}

/**
 * Delete a relationship
 */
export function deleteRelationship(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM relationships WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}
