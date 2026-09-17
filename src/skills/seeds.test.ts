import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { listSkills, upsertSkill, getSkillByName, setSkillSigningKey } from '../vault/skills.ts';
import { seedSkills } from './seeds.ts';
import { runSkill, validateSteps, type SkillRuntimeDeps } from './runtime.ts';
import { resolveSkillEffect } from './effects.ts';

const SEED_NAMES = ['gcal-create-event', 'gmail-compose', 'notion-new-page', 'sheets-append-row', 'slack-send-message'];

describe('seed skills', () => {
  beforeEach(() => { initDatabase(':memory:'); setSkillSigningKey(Buffer.alloc(32, 7)); });
  afterEach(() => { closeDb(); setSkillSigningKey(null); });

  test('seeds all starter skills as signed, runnable browser skills', () => {
    seedSkills();
    const seeded = listSkills(true);
    expect(seeded.map((s) => s.name).sort()).toEqual(SEED_NAMES);
    for (const s of seeded) {
      expect(s.integrity).toBe('ok');
      expect(validateSteps(s.steps)).toBeNull();
      // Web apps: every step runs on the browser surface.
      expect(s.steps.every((step) => step.surface === 'browser')).toBe(true);
      // params referenced in steps exist in the param list
      const declared = new Set(s.params.map((p) => p.name));
      const used = JSON.stringify(s.steps).match(/\{\{(\w+)\}\}/g) ?? [];
      for (const u of used) {
        expect(declared.has(u.replace(/[{}]/g, ''))).toBe(true);
      }
    }
  });

  test('is idempotent and preserves a user-recorded skill of the same name', () => {
    // User records their own gmail-compose before seeding.
    upsertSkill({ name: 'gmail-compose', description: 'MY version', steps: [{ action: 'wait', ms: 1 }], provenance: 'recorded' });
    seedSkills();
    seedSkills(); // twice
    const g = getSkillByName('gmail-compose')!;
    expect(g.description).toBe('MY version'); // not clobbered
    expect(g.provenance).toBe('recorded');
    expect(g.version).toBe(1);
    // other seeds still installed once
    expect(listSkills(true).filter((s) => s.name === 'slack-send-message')).toHaveLength(1);
  });

  test('the shipped effects are what the gate sees: gmail sends email, slack sends a message', () => {
    seedSkills();
    const gmail = resolveSkillEffect(getSkillByName('gmail-compose')!, { to: 'a@b.com', subject: 'hi', body: 'x' });
    expect(gmail.category).toBe('send_email');
    expect(gmail.intent).toContain('click Send (sends email)');
    expect(gmail.intent).toContain('"a@b.com" into To recipients');
    const slack = resolveSkillEffect(getSkillByName('slack-send-message')!, { text: 'yo' });
    expect(slack.categories).toEqual(['control_app', 'send_message']);
    expect(slack.intent).toContain('press enter (sends a message)');
    const sheets = resolveSkillEffect(getSkillByName('sheets-append-row')!, { value: '1' });
    expect(sheets.categories).toEqual(['control_app']);
  });

  test('gmail-compose runs end-to-end against a scripted surface', async () => {
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
    const kinds: string[] = [];
    const deps: SkillRuntimeDeps = {
      snapshot: async (kind) => {
        kinds.push(kind);
        return { nodes: sent ? nodes.filter((n) => n.name !== 'Send') : nodes, title: 'Compose' };
      },
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
    expect(new Set(kinds)).toEqual(new Set(['browser']));
  });
});
