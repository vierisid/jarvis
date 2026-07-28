import { getDb, generateId } from './schema.ts';

export type VectorRecord = {
  id: string;
  ref_type: string;
  ref_id: string;
  embedding: Float32Array;
  model: string;
  created_at: number;
};

type VectorRow = {
  id: string;
  ref_type: string;
  ref_id: string;
  embedding: ArrayBuffer;
  model: string;
  created_at: number;
};

/**
 * Parse vector row from database, converting BLOB to Float32Array
 */
function parseVector(row: VectorRow): VectorRecord {
  return {
    ...row,
    embedding: new Float32Array(row.embedding),
  };
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value in [-1, 1] where 1 = identical direction, 0 = orthogonal.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Store a vector embedding for a reference entity or fact
 */
export function storeVector(
  ref_type: string,
  ref_id: string,
  embedding: Float32Array,
  model: string
): VectorRecord {
  const db = getDb();
  const id = generateId();
  const now = Date.now();

  // Delete any existing vector with same ref_type + ref_id + model
  // so each (ref, model) pair is a single embedding.
  const deleteStmt = db.prepare(
    'DELETE FROM vectors WHERE ref_type = ? AND ref_id = ? AND model = ?'
  );
  deleteStmt.run(ref_type, ref_id, model);

  // Convert Float32Array to Buffer for SQLite BLOB storage
  const buffer = Buffer.from(embedding.buffer);

  const stmt = db.prepare(
    'INSERT INTO vectors (id, ref_type, ref_id, embedding, model, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  stmt.run(id, ref_type, ref_id, buffer, model, now);

  return {
    id,
    ref_type,
    ref_id,
    embedding,
    model,
    created_at: now,
  };
}

/**
 * Find similar vectors using in-memory cosine similarity.
 *
 * Loads all vectors from the database and compares against the query embedding.
 * For small-to-medium vector stores (< 100K vectors) this performs well.
 *
 * TODO: For production use with larger datasets, integrate sqlite-vec extension
 * which provides optimized vector similarity search with HNSW indexing.
 * See: https://github.com/asg017/sqlite-vec
 *
 * Example with sqlite-vec:
 *   SELECT ref_type, ref_id, vec_distance_cosine(embedding, ?) as similarity
 *   FROM vectors
 *   ORDER BY similarity DESC
 *   LIMIT ?
 *
 * @param embedding - Query embedding vector
 * @param limit - Maximum number of results to return (default 10)
 * @param opts.minScore - Minimum cosine similarity threshold (default 0.0)
 * @returns Array of {ref_type, ref_id, similarity} sorted by similarity descending
 */
export function findSimilar(
  embedding: Float32Array,
  limit: number = 10,
  opts?: { minScore?: number }
): Array<{ ref_type: string; ref_id: string; similarity: number }> {
  const db = getDb();
  const minScore = opts?.minScore ?? 0.0;

  const rows = db.prepare(
    'SELECT id, ref_type, ref_id, embedding, model, created_at FROM vectors'
  ).all() as VectorRow[];

  if (rows.length === 0) return [];

  const scored: Array<{ ref_type: string; ref_id: string; similarity: number }> = [];

  for (const row of rows) {
    const vec = parseVector(row);
    const sim = cosineSimilarity(embedding, vec.embedding);
    if (sim >= minScore) {
      scored.push({
        ref_type: row.ref_type,
        ref_id: row.ref_id,
        similarity: sim,
      });
    }
  }

  // Sort descending by similarity
  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit);
}

/**
 * Find vectors similar to a given reference entity's embedding.
 * Convenience wrapper when you have a ref_type + ref_id and want to find
 * semantically related content.
 *
 * @param ref_type - Reference type to search by
 * @param ref_id - Reference ID whose embedding to use as query
 * @param limit - Max results (default 10)
 * @param opts - Optional settings (model filter, minScore)
 * @returns Array of {ref_type, ref_id, similarity} or empty if source not found
 */
export function findSimilarByRef(
  ref_type: string,
  ref_id: string,
  limit: number = 10,
  opts?: { model?: string; minScore?: number }
): Array<{ ref_type: string; ref_id: string; similarity: number }> {
  const db = getDb();

  let query = 'SELECT id, ref_type, ref_id, embedding, model, created_at FROM vectors WHERE ref_type = ? AND ref_id = ?';
  const params: unknown[] = [ref_type, ref_id];

  if (opts?.model) {
    query += ' AND model = ?';
    params.push(opts.model);
  }

  const sourceRow = db.prepare(query).get(...params) as VectorRow | undefined;
  if (!sourceRow) return [];

  const queryEmbedding = parseVector(sourceRow).embedding;
  return findSimilar(queryEmbedding, limit, { minScore: opts?.minScore });
}

/**
 * Delete all vectors for a given reference
 */
export function deleteVectors(ref_type: string, ref_id: string): void {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM vectors WHERE ref_type = ? AND ref_id = ?');
  stmt.run(ref_type, ref_id);
}

/**
 * Count total vectors in the database.
 */
export function countVectors(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM vectors').get() as { count: number };
  return row.count;
}
