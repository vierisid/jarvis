import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { listSkills, upsertSkill, getSkillByName } from '../vault/skills.ts';
import { seedSkills, SEED_SKILL_NAMES } from './seeds.ts';
import { runSkill, type SkillRuntimeDeps } from './runtime.ts';

describe('seed skills', () => {
  afterEach(() => closeDb());

  test('seeds all starter skills with valid, parseable structure', () => {
    initDatabase(':memory:');
    seedSkills();
    const seeded = listSkills(true);
    expect(seeded.map((s) => s.name).sort()).toEqual([...SEED_SKILL_NAMES].sort());
    // every step has an action; element steps carry a ref
    for (const s of seeded) {
      expect(s.steps.length).toBeGreaterThan(0);
      for (const step of s.steps) {
        expect(step.action).toBeTruthy();
      }
      // params referenced in steps exist in the param list
      const declared = new Set(s.params.map((p) => p.name));
      const used = JSON.stringify(s.steps).match(/\{\{(\w+)\}\}/g) ?? [];
      for (const u of used) {
        const nm = u.replace(/[{}]/g, '');
        expect(declared.has(nm)).toBe(true);
      }
    }
  });

  test('is idempotent and preserves a user-edited skill of the same name', () => {
    initDatabase(':memory:');
    // User records their own gmail-compose before seeding.
    upsertSkill({ name: 'gmail-compose', description: 'MY version', steps: [{ action: 'wait', ms: 1 }], provenance: 'recorded' });
    seedSkills();
    seedSkills(); // twice
    const g = getSkillByName('gmail-compose')!;
    expect(g.description).toBe('MY version'); // not clobbered
    expect(g.provenance).toBe('recorded');
    // other seeds still installed once
    expect(listSkills(true).filter((s) => s.name === 'slack-send-message')).toHaveLength(1);
  });

  test('gmail-compose runs end-to-end against a scripted surface', async () => {
    initDatabase(':memory:');
    seedSkills();
    const gmail = getSkillByName('gmail-compose')!;

    // A surface that always contains the elements the skill needs, by name.
    const el = (role: string, name: string, sid: number) => ({
      ref: { role, name, path: [], ordinal: 0, sig: '' },
      role, name, value: null as string | null,
      state: { enabled: true }, bounds: null, actions: ['click', 'set_value'], sessionId: sid,
    });
    const nodes = [
      el('button', 'Compose', 1), el('textbox', 'To recipients', 2),
      el('textbox', 'Subject', 3), el('textbox', 'Message Body', 4), el('button', 'Send', 5),
    ];
    // Track set values so value_equals on Subject passes, and simulate Send
    // removing the Compose button (element_gone).
    let sent = false;
    const deps: SkillRuntimeDeps = {
      snapshot: async () => ({
        nodes: sent ? nodes.filter((n) => n.name !== 'Send') : nodes,
        title: 'Compose',
      }),
      act: async (_k, sid, action, value) => {
        const n = nodes.find((x) => x.sessionId === sid)!;
        if (action === 'set_value') n.value = value ?? '';
        if (n.name === 'Send') sent = true;
      },
      raw: async () => {},
      sleep: async () => {},
    };

    const res = await runSkill(gmail, { to: 'a@b.com', subject: 'hi', body: 'hello' }, deps);
    expect(res.ok).toBe(true);
    expect(nodes.find((n) => n.name === 'Subject')!.value).toBe('hi');
  });
});
