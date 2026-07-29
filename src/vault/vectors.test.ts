import { test, expect, beforeEach, describe } from 'bun:test';
import { initDatabase } from './schema.ts';
import {
  storeVector,
  findSimilar,
  findSimilarByRef,
  deleteVectors,
  countVectors,
} from './vectors.ts';

const MODEL = 'test-model';

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('vectors', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  describe('storeVector', () => {
    test('stores and returns the record', () => {
      const record = storeVector('note', 'n1', vec(1, 2, 3), MODEL);
      expect(record.ref_type).toBe('note');
      expect(record.ref_id).toBe('n1');
      expect(record.model).toBe(MODEL);
      expect(countVectors()).toBe(1);
    });

    test('roundtrips embedding values through the BLOB column', () => {
      storeVector('note', 'n1', vec(0.25, -1.5, 3.75), MODEL);
      // an identical query vector must score similarity ~1.0
      const results = findSimilar(vec(0.25, -1.5, 3.75), 10);
      expect(results.length).toBe(1);
      expect(results[0]!.similarity).toBeCloseTo(1.0, 5);
    });

    test('roundtrips an embedding stored as an offset subarray view', () => {
      const backing = new Float32Array([9, 9, 0.5, -0.5, 2.0, 9]);
      storeVector('note', 'n1', backing.subarray(2, 5), MODEL);
      const results = findSimilar(vec(0.5, -0.5, 2.0), 10);
      expect(results.length).toBe(1);
      expect(results[0]!.similarity).toBeCloseTo(1.0, 5);
    });

    test('replaces an existing (ref_type, ref_id, model) embedding', () => {
      storeVector('note', 'n1', vec(1, 0), MODEL);
      storeVector('note', 'n1', vec(0, 1), MODEL);
      expect(countVectors()).toBe(1);
      const results = findSimilar(vec(0, 1), 10);
      expect(results[0]!.similarity).toBeCloseTo(1.0, 5);
    });

    test('keeps embeddings from different models for the same ref', () => {
      storeVector('note', 'n1', vec(1, 0), 'model-a');
      storeVector('note', 'n1', vec(0, 1), 'model-b');
      expect(countVectors()).toBe(2);
    });
  });

  describe('findSimilar', () => {
    test('returns empty array when store is empty', () => {
      expect(findSimilar(vec(1, 0, 0))).toEqual([]);
    });

    test('ranks results by cosine similarity descending', () => {
      storeVector('note', 'identical', vec(1, 0), MODEL);
      storeVector('note', 'close', vec(1, 0.2), MODEL);
      storeVector('note', 'orthogonal', vec(0, 1), MODEL);

      const results = findSimilar(vec(1, 0), 10);
      expect(results.map((r) => r.ref_id)).toEqual(['identical', 'close', 'orthogonal']);
      expect(results[0]!.similarity).toBeCloseTo(1.0, 5);
      expect(results[2]!.similarity).toBeCloseTo(0.0, 5);
    });

    test('respects the limit', () => {
      for (let i = 0; i < 5; i++) {
        storeVector('note', `n${i}`, vec(1, i), MODEL);
      }
      expect(findSimilar(vec(1, 0), 2).length).toBe(2);
    });

    test('filters by minScore', () => {
      storeVector('note', 'same', vec(1, 0), MODEL);
      storeVector('note', 'opposite', vec(-1, 0), MODEL);

      const results = findSimilar(vec(1, 0), 10, { minScore: 0.5 });
      expect(results.map((r) => r.ref_id)).toEqual(['same']);
    });

    test('handles a zero-norm query without NaN', () => {
      storeVector('note', 'n1', vec(1, 2), MODEL);
      const results = findSimilar(vec(0, 0), 10);
      expect(results[0]!.similarity).toBe(0);
    });

    test('skips candidates whose dimensionality differs from the query', () => {
      storeVector('note', 'two-dim', vec(1, 0), MODEL);
      storeVector('note', 'three-dim', vec(1, 0, 0), MODEL);

      const results = findSimilar(vec(1, 0, 0), 10);
      expect(results.map((r) => r.ref_id)).toEqual(['three-dim']);
    });

    test('filters candidates by model when asked', () => {
      storeVector('note', 'a', vec(1, 0), 'model-a');
      storeVector('note', 'b', vec(1, 0), 'model-b');

      const results = findSimilar(vec(1, 0), 10, { model: 'model-a' });
      expect(results.map((r) => r.ref_id)).toEqual(['a']);
      expect(results[0]!.model).toBe('model-a');
    });

    test('labels each match with its model when scanning across models', () => {
      storeVector('note', 'n1', vec(1, 0), 'model-a');
      storeVector('note', 'n1', vec(1, 0), 'model-b');

      const results = findSimilar(vec(1, 0), 10);
      expect(results.length).toBe(2);
      expect(results.map((r) => r.model).sort()).toEqual(['model-a', 'model-b']);
    });

    test('excludes a given ref when asked', () => {
      storeVector('note', 'n1', vec(1, 0), MODEL);
      storeVector('note', 'n2', vec(1, 0.1), MODEL);

      const results = findSimilar(vec(1, 0), 10, { exclude: { ref_type: 'note', ref_id: 'n1' } });
      expect(results.map((r) => r.ref_id)).toEqual(['n2']);
    });
  });

  describe('findSimilarByRef', () => {
    test('returns empty array when the source ref has no embedding', () => {
      expect(findSimilarByRef('note', 'missing')).toEqual([]);
    });

    test('finds related refs without returning the source itself', () => {
      storeVector('note', 'source', vec(1, 0, 0), MODEL);
      storeVector('note', 'related', vec(0.9, 0.1, 0), MODEL);
      storeVector('note', 'unrelated', vec(0, 0, 1), MODEL);

      const results = findSimilarByRef('note', 'source', 10);
      expect(results.map((r) => r.ref_id)).toEqual(['related', 'unrelated']);
    });

    test('filters the source lookup by model', () => {
      storeVector('note', 'source', vec(1, 0), 'model-a');
      storeVector('note', 'source', vec(0, 1), 'model-b');
      storeVector('note', 'other', vec(0, 1), 'model-b');

      const results = findSimilarByRef('note', 'source', 10, { model: 'model-b' });
      expect(results[0]!.ref_id).toBe('other');
      expect(results[0]!.similarity).toBeCloseTo(1.0, 5);
    });

    test('only scores candidates from the same model as the source embedding', () => {
      storeVector('note', 'source', vec(1, 0), 'model-a');
      storeVector('note', 'same-model', vec(1, 0.1), 'model-a');
      storeVector('note', 'other-model', vec(1, 0), 'model-b');

      const results = findSimilarByRef('note', 'source', 10, { model: 'model-a' });
      expect(results.map((r) => r.ref_id)).toEqual(['same-model']);
    });

    test('applies minScore to results', () => {
      storeVector('note', 'source', vec(1, 0), MODEL);
      storeVector('note', 'far', vec(-1, 0), MODEL);

      expect(findSimilarByRef('note', 'source', 10, { minScore: 0.5 })).toEqual([]);
    });
  });

  describe('deleteVectors', () => {
    test('removes all embeddings for a ref', () => {
      storeVector('note', 'n1', vec(1, 0), 'model-a');
      storeVector('note', 'n1', vec(0, 1), 'model-b');
      storeVector('note', 'n2', vec(1, 1), 'model-a');

      deleteVectors('note', 'n1');
      expect(countVectors()).toBe(1);
      expect(findSimilarByRef('note', 'n1')).toEqual([]);
    });
  });
});
