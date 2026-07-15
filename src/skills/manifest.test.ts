import { afterEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { upsertSkill, getSkillByName, recordSkillRun } from '../vault/skills.ts';
import { exportSkill, importSkill, serializeManifest, type SkillManifest } from './manifest.ts';
import type { SkillStep } from './types.ts';

const STEPS: SkillStep[] = [
  { action: 'launch_app', value: 'notepad.exe', postcondition: { kind: 'window_appeared' } },
  { action: 'set_value', ref: { role: 'Edit', name: 'Body', path: [], ordinal: 0, sig: 's' }, value: '{{text}}' },
];

describe('skill manifest export/import', () => {
  afterEach(() => closeDb());

  test('round-trips a skill through export → import', () => {
    initDatabase(':memory:');
    const created = upsertSkill({ name: 'note', app: 'notepad', description: 'jot', steps: STEPS, params: [{ name: 'text', type: 'string', description: 't', required: true }] });
    recordSkillRun(created.id, true);
    recordSkillRun(created.id, true);
    const orig = getSkillByName('note')!; // re-read to pick up the run stats

    const manifest = exportSkill(orig, 'alice');
    expect(manifest.successRate).toBe(1);
    expect(manifest.publisher).toBe('alice');

    // Fresh DB simulates another machine.
    closeDb();
    initDatabase(':memory:');
    const res = importSkill(manifest);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.skill.name).toBe('note');
    expect(res.skill.provenance).toBe('marketplace');
    expect(res.skill.steps).toHaveLength(2);
    // exporter stats are NOT inherited
    expect(res.skill.runCount).toBe(0);
  });

  test('rejects a tampered manifest (hash mismatch)', () => {
    initDatabase(':memory:');
    const orig = upsertSkill({ name: 'x', steps: STEPS });
    const manifest = exportSkill(orig);
    const tampered: SkillManifest = { ...manifest, steps: [{ action: 'press_keys', value: 'ctrl,a' }] };
    const res = importSkill(tampered);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('hash mismatch');
  });

  test('rejects an unknown manifest version', () => {
    initDatabase(':memory:');
    const m = exportSkill(upsertSkill({ name: 'x', steps: STEPS }));
    const res = importSkill({ ...m, manifestVersion: 999 });
    expect(res.ok).toBe(false);
  });

  test('does not overwrite a local skill of the same name — suffixes instead', () => {
    initDatabase(':memory:');
    const m = exportSkill(upsertSkill({ name: 'compose', steps: STEPS }));
    // A different local skill already owns "compose".
    upsertSkill({ name: 'compose', description: 'my local one', steps: [{ action: 'wait', ms: 1 }] });
    const res = importSkill(m);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.renamedFrom).toBe('compose');
    expect(res.skill.name).toBe('compose-2');
    // local one untouched
    expect(getSkillByName('compose')!.description).toBe('my local one');
  });

  test('serializeManifest produces valid JSON', () => {
    initDatabase(':memory:');
    const m = exportSkill(upsertSkill({ name: 'x', steps: STEPS }));
    expect(() => JSON.parse(serializeManifest(m))).not.toThrow();
  });
});
