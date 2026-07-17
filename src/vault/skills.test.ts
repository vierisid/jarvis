import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from './schema.ts';
import {
  upsertSkill, getSkillByName, listSkills, deleteSkill, recordSkillRun, matchSkills,
} from './skills.ts';
import type { SkillStep } from '../skills/types.ts';

const STEPS: SkillStep[] = [
  { action: 'launch_app', value: 'notepad.exe', postcondition: { kind: 'window_appeared' } },
  { action: 'set_value', ref: { role: 'Edit', name: 'Text Editor', path: [], ordinal: 0, sig: 'x' }, value: '{{body}}' },
];

describe('Vault — Skills', () => {
  afterEach(() => closeDb());

  test('upsert inserts then updates by name, bumping version', () => {
    initDatabase(':memory:');
    const a = upsertSkill({ name: 'note', description: 'jot a note', steps: STEPS, app: 'notepad' });
    expect(a.version).toBe(1);
    expect(a.steps).toHaveLength(2);

    const b = upsertSkill({ name: 'note', description: 'jot a note v2', steps: STEPS });
    expect(b.id).toBe(a.id);
    expect(b.version).toBe(2);
    expect(b.description).toBe('jot a note v2');
  });

  test('getByName is case-insensitive; list respects enabled', () => {
    initDatabase(':memory:');
    upsertSkill({ name: 'Compose Mail', steps: STEPS });
    expect(getSkillByName('compose mail')?.name).toBe('Compose Mail');
    upsertSkill({ name: 'Disabled One', steps: STEPS, enabled: false });
    expect(listSkills(true).map((s) => s.name)).toEqual(['Compose Mail']);
    expect(listSkills(false)).toHaveLength(2);
  });

  test('recordSkillRun accumulates the successRate signal', () => {
    initDatabase(':memory:');
    const s = upsertSkill({ name: 'x', steps: STEPS });
    recordSkillRun(s.id, true);
    recordSkillRun(s.id, false);
    recordSkillRun(s.id, true);
    const got = getSkillByName('x')!;
    expect(got.runCount).toBe(3);
    expect(got.successCount).toBe(2);
    expect(got.verifiedAt).toBeGreaterThan(0);
  });

  test('matchSkills is URL/process-aware, not just message text', () => {
    initDatabase(':memory:');
    upsertSkill({ name: 'gmail-compose', app: 'gmail', steps: STEPS, match: { domains: ['mail.google.com'], keywords: ['email', 'compose'] } });
    upsertSkill({ name: 'slack-dm', app: 'slack', steps: STEPS, match: { processNames: ['slack'], keywords: ['message'] } });

    expect(matchSkills('send an email').map((s) => s.name)).toEqual(['gmail-compose']);
    // URL match with an unrelated message
    expect(matchSkills('do the thing', { url: 'https://mail.google.com/mail/u/0' }).map((s) => s.name)).toEqual(['gmail-compose']);
    // process match
    expect(matchSkills('anything', { processName: 'Slack.exe' }).map((s) => s.name)).toEqual(['slack-dm']);
  });

  test('delete removes the skill', () => {
    initDatabase(':memory:');
    const s = upsertSkill({ name: 'tmp', steps: STEPS });
    deleteSkill(s.id);
    expect(getSkillByName('tmp')).toBeNull();
  });
});
