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
  embedding: Uint8Array;
  model: string;
  created_at: number;
};

export type SimilarityMatch = {
  ref_type: string;
  ref_id: string;
  model: string;
  similarity: number;
};

/**
 * Parse vector row from database, converting BLOB to Float32Array.
 * bun:sqlite returns BLOBs as Uint8Array; reinterpret the underlying bytes
 * as float32 values rather than copying byte-by-byte.
 */
function blobToFloat32(blob: Uint8Array): Float32Array {
  const { buffer, byteOffset, byteLength } = blob;
  return new Float32Array(buffer, byteOffset, Math.floor(byteLength / Float32Array.BYTES_PER_ELEMENT));
}

function parseVector(row: VectorRow): VectorRecord {
  return {
    ...row,
    embedding: blobToFloat32(row.embedding),
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
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Store a vector embedding for a reference entity or fact.
 * Upsert semantics: any existing embedding for the same
 * (ref_type, ref_id, model) triple is replaced atomically.
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

  const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

  const upsert = db.transaction(() => {
    db.prepare(
      'DELETE FROM vectors WHERE ref_type = ? AND ref_id = ? AND model = ?'
    ).run(ref_type, ref_id, model);
    db.prepare(
      'INSERT INTO vectors (id, ref_type, ref_id, embedding, model, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, ref_type, ref_id, buffer, model, now);
  });
  upsert();

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
 * Candidates whose dimensionality differs from the query are skipped —
 * embeddings from different models are not comparable. Without a model
 * filter, a ref embedded under several same-dimension models can appear
 * once per model; the `model` field on each match disambiguates.
 *
 * @param embedding - Query embedding vector
 * @param limit - Maximum number of results to return (default 10)
 * @param opts.minScore - Minimum cosine similarity threshold (default 0.0)
 * @param opts.model - Only score embeddings produced by this model
 * @param opts.exclude - Reference to omit from results (e.g. the query's own ref)
 * @returns Array of {ref_type, ref_id, model, similarity} sorted by similarity descending
 */
export function findSimilar(
  embedding: Float32Array,
  limit: number = 10,
  opts?: { minScore?: number; model?: string; exclude?: { ref_type: string; ref_id: string } }
): SimilarityMatch[] {
  const db = getDb();
  const minScore = opts?.minScore ?? 0.0;
  const exclude = opts?.exclude;

  let query = 'SELECT ref_type, ref_id, embedding, model FROM vectors';
  const params: string[] = [];
  if (opts?.model) {
    query += ' WHERE model = ?';
    params.push(opts.model);
  }

  const rows = db.prepare(query).all(...params) as Array<
    Pick<VectorRow, 'ref_type' | 'ref_id' | 'embedding' | 'model'>
  >;

  const scored: SimilarityMatch[] = [];

  for (const row of rows) {
    if (exclude && row.ref_type === exclude.ref_type && row.ref_id === exclude.ref_id) {
      continue;
    }
    const vec = blobToFloat32(row.embedding);
    if (vec.length !== embedding.length) {
      continue;
    }
    const sim = cosineSimilarity(embedding, vec);
    if (sim >= minScore) {
      scored.push({
        ref_type: row.ref_type,
        ref_id: row.ref_id,
        model: row.model,
        similarity: sim,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit);
}

/**
 * Find vectors similar to a given reference entity's embedding.
 * Convenience wrapper when you have a ref_type + ref_id and want to find
 * semantically related content. The source reference itself is excluded
 * from the results, and only candidates from the same model as the source
 * embedding are scored. When the ref has embeddings from several models and
 * no model is given, the most recently stored one is used.
 *
 * @param ref_type - Reference type to search by
 * @param ref_id - Reference ID whose embedding to use as query
 * @param limit - Max results (default 10)
 * @param opts - Optional settings (model filter, minScore)
 * @returns Array of {ref_type, ref_id, model, similarity} or empty if source not found
 */
export function findSimilarByRef(
  ref_type: string,
  ref_id: string,
  limit: number = 10,
  opts?: { model?: string; minScore?: number }
): SimilarityMatch[] {
  const db = getDb();

  let query = 'SELECT id, ref_type, ref_id, embedding, model, created_at FROM vectors WHERE ref_type = ? AND ref_id = ?';
  const params: string[] = [ref_type, ref_id];

  if (opts?.model) {
    query += ' AND model = ?';
    params.push(opts.model);
  }
  query += ' ORDER BY created_at DESC LIMIT 1';

  const sourceRow = db.prepare(query).get(...params) as VectorRow | undefined;
  if (!sourceRow) return [];

  const queryEmbedding = parseVector(sourceRow).embedding;
  return findSimilar(queryEmbedding, limit, {
    minScore: opts?.minScore,
    model: sourceRow.model,
    exclude: { ref_type, ref_id },
  });
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
