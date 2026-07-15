import { describe, expect, it } from 'bun:test';
import { bestOfN } from './best-of-n.ts';

describe('bestOfN', () => {
  it('selects the highest-scored approved candidate', async () => {
    const res = await bestOfN<string>(
      {
        generate: async (i) => `plan-${i}`,
        // plan-1 scores highest and is approved
        judge: async (c) => ({ score: c === 'plan-1' ? 0.9 : 0.4, approve: true }),
      },
      { n: 3, judges: 3 },
    );
    expect(res.winner).toBe('plan-1');
    expect(res.ranked[0]!.value).toBe('plan-1');
  });

  it('returns no winner when the top candidate is not approved by a majority', async () => {
    const res = await bestOfN<string>(
      {
        generate: async (i) => `plan-${i}`,
        // high score but judges refuse
        judge: async (_c, j) => ({ score: 0.95, approve: j === 0 }), // 1/3 approve
      },
      { n: 2, judges: 3, approvalThreshold: 0.5 },
    );
    expect(res.winner).toBeNull();
    expect(res.reason).toContain('approval bar');
  });

  it('prefers a slightly-lower-scored candidate that clears approval over a higher one that does not', async () => {
    const res = await bestOfN<string>(
      {
        generate: async (i) => `p${i}`,
        judge: async (c, j) => {
          if (c === 'p0') return { score: 0.99, approve: false }; // best score, refused
          return { score: 0.7, approve: j < 2 }; // 2/3 approve
        },
      },
      { n: 2, judges: 3 },
    );
    expect(res.winner).toBe('p1');
  });

  it('drops failed rollouts and still judges the rest', async () => {
    const res = await bestOfN<string>(
      {
        generate: async (i) => { if (i === 0) throw new Error('rollout failed'); return `p${i}`; },
        judge: async () => ({ score: 0.8, approve: true }),
      },
      { n: 3, judges: 1 },
    );
    expect(res.winner).toBeTruthy();
    expect(res.ranked.length).toBe(2);
  });

  it('returns null with a reason when every rollout fails', async () => {
    const res = await bestOfN<string>(
      { generate: async () => { throw new Error('nope'); }, judge: async () => ({ score: 1, approve: true }) },
      { n: 2 },
    );
    expect(res.winner).toBeNull();
    expect(res.reason).toContain('all candidate rollouts failed');
  });
});
