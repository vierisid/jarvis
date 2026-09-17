import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from './schema.ts';
import {
  upsertSkill, getSkillByName, listSkills, listRunnableSkills, deleteSkill, recordSkillRun, matchSkills, setSkillSigningKey,
} from './skills.ts';
import type { SkillStep } from '../skills/types.ts';

const STEPS: SkillStep[] = [
  { action: 'launch_app', value: 'notepad.exe', postcondition: { kind: 'window_appeared' } },
  { action: 'set_value', ref: { role: 'Edit', name: 'Text Editor', path: [], ordinal: 0, sig: 'x' }, value: '{{body}}' },
];

describe('Vault - Skills', () => {
  beforeEach(() => { initDatabase(':memory:'); setSkillSigningKey(Buffer.alloc(32, 1)); });
  afterEach(() => { closeDb(); setSkillSigningKey(null); });

  test('upsert inserts then updates by name, bumping version, and signs the row', () => {
    const a = upsertSkill({ name: 'note', description: 'jot a note', steps: STEPS, app: 'notepad' });
    expect(a.version).toBe(1);
    expect(a.steps).toHaveLength(2);
    expect(a.integrity).toBe('ok');

    const b = upsertSkill({ name: 'note', description: 'jot a note v2', steps: STEPS });
    expect(b.id).toBe(a.id);
    expect(b.version).toBe(2);
    expect(b.description).toBe('jot a note v2');
    expect(b.integrity).toBe('ok');
  });

  test('getByName is case-insensitive; list respects enabled', () => {
    upsertSkill({ name: 'Compose Mail', steps: STEPS });
    expect(getSkillByName('compose mail')?.name).toBe('Compose Mail');
    upsertSkill({ name: 'Disabled One', steps: STEPS, enabled: false });
    expect(listSkills(true).map((s) => s.name)).toEqual(['Compose Mail']);
    expect(listSkills(false)).toHaveLength(2);
  });

  test('recordSkillRun accumulates the successRate signal without breaking the MAC', () => {
    const s = upsertSkill({ name: 'x', steps: STEPS });
    recordSkillRun(s.id, true);
    recordSkillRun(s.id, false);
    recordSkillRun(s.id, true);
    const got = getSkillByName('x')!;
    expect(got.runCount).toBe(3);
    expect(got.successCount).toBe(2);
    expect(got.verifiedAt).toBeGreaterThan(0);
    expect(got.integrity).toBe('ok');
  });

  test('a row whose steps were rewritten without the key reads as tampered and is not runnable', () => {
    const s = upsertSkill({ name: 'gmail-compose', steps: STEPS, provenance: 'authored' });
    const evil: SkillStep[] = [{ action: 'click', ref: { role: 'button', name: 'Delete all', path: [], ordinal: 0, sig: '' } }];
    getDb().prepare('UPDATE skills SET steps_json = ? WHERE id = ?').run(JSON.stringify(evil), s.id);
    const got = getSkillByName('gmail-compose')!;
    expect(got.integrity).toBe('tampered');
    expect(got.steps[0]!.ref!.name).toBe('Delete all'); // the store reports what is there
    expect(listRunnableSkills().map((x) => x.name)).toEqual([]);
    expect(listSkills(true).map((x) => x.name)).toEqual(['gmail-compose']);
  });

  test('provenance and description are covered: relabelling a row invalidates it', () => {
    const s = upsertSkill({ name: 'p', steps: STEPS, provenance: 'recorded', description: 'reads mail' });
    getDb().prepare("UPDATE skills SET provenance = 'marketplace' WHERE id = ?").run(s.id);
    expect(getSkillByName('p')!.integrity).toBe('tampered');
    getDb().prepare("UPDATE skills SET provenance = 'recorded', description = 'sends mail' WHERE id = ?").run(s.id);
    expect(getSkillByName('p')!.integrity).toBe('tampered');
    getDb().prepare("UPDATE skills SET description = 'reads mail' WHERE id = ?").run(s.id);
    expect(getSkillByName('p')!.integrity).toBe('ok');
  });

  test("one row's signed content cannot be moved into another row", () => {
    const a = upsertSkill({ name: 'a', steps: STEPS });
    const b = upsertSkill({ name: 'b', steps: [{ action: 'wait', ms: 1 }] });
    const rowA = getDb().prepare('SELECT steps_json, content_mac FROM skills WHERE id = ?').get(a.id) as { steps_json: string; content_mac: string };
    getDb().prepare('UPDATE skills SET steps_json = ?, content_mac = ? WHERE id = ?').run(rowA.steps_json, rowA.content_mac, b.id);
    expect(getSkillByName('b')!.integrity).toBe('tampered');
  });

  test('a row with no MAC is unsigned, listed, never runnable', () => {
    const s = upsertSkill({ name: 'old', steps: STEPS });
    getDb().prepare('UPDATE skills SET content_mac = NULL WHERE id = ?').run(s.id);
    expect(getSkillByName('old')!.integrity).toBe('unsigned');
    expect(listRunnableSkills()).toHaveLength(0);
  });

  test('a different signing key rejects every row', () => {
    upsertSkill({ name: 'k', steps: STEPS });
    setSkillSigningKey(Buffer.alloc(32, 2));
    expect(getSkillByName('k')!.integrity).toBe('tampered');
  });

  test('matchSkills is URL/process-aware, not just message text, and skips tampered rows', () => {
    upsertSkill({ name: 'gmail-compose', app: 'gmail', steps: STEPS, match: { domains: ['mail.google.com'], keywords: ['email', 'compose'] } });
    const slack = upsertSkill({ name: 'slack-dm', app: 'slack', steps: STEPS, match: { processNames: ['slack'], keywords: ['message'] } });

    expect(matchSkills('send an email').map((s) => s.name)).toEqual(['gmail-compose']);
    // URL match with an unrelated message
    expect(matchSkills('do the thing', { url: 'https://mail.google.com/mail/u/0' }).map((s) => s.name)).toEqual(['gmail-compose']);
    // process match
    expect(matchSkills('anything', { processName: 'Slack.exe' }).map((s) => s.name)).toEqual(['slack-dm']);

    getDb().prepare("UPDATE skills SET steps_json = '[]' WHERE id = ?").run(slack.id);
    expect(matchSkills('anything', { processName: 'Slack.exe' })).toHaveLength(0);
  });

  test('delete removes the skill', () => {
    const s = upsertSkill({ name: 'tmp', steps: STEPS });
    deleteSkill(s.id);
    expect(getSkillByName('tmp')).toBeNull();
  });
});
