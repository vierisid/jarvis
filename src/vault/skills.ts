/**
 * Skills store — vault persistence for parameterized, verified procedures.
 * Replaces the markdown webapp_templates store (which coexists during
 * migration). See src/skills/types.ts for the model.
 */

import { getDb, generateId } from './schema.ts';
import type { Skill, SkillMatch, SkillParam, SkillStep } from '../skills/types.ts';

type SkillRow = {
  id: string;
  name: string;
  app: string;
  description: string;
  match_json: string;
  params_json: string;
  steps_json: string;
  provenance: Skill['provenance'];
  version: number;
  enabled: number;
  success_count: number;
  run_count: number;
  verified_at: number | null;
  created_at: number;
  updated_at: number;
};

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    app: row.app,
    description: row.description,
    match: JSON.parse(row.match_json) as SkillMatch,
    params: JSON.parse(row.params_json) as SkillParam[],
    steps: JSON.parse(row.steps_json) as SkillStep[],
    provenance: row.provenance,
    version: row.version,
    enabled: row.enabled === 1,
    successCount: row.success_count,
    runCount: row.run_count,
    verifiedAt: row.verified_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type UpsertSkill = {
  name: string;
  app?: string;
  description?: string;
  match?: SkillMatch;
  params?: SkillParam[];
  steps: SkillStep[];
  provenance?: Skill['provenance'];
  version?: number;
  enabled?: boolean;
};

/** Insert or update a skill by name. */
export function upsertSkill(s: UpsertSkill): Skill {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare('SELECT id, version FROM skills WHERE name = ?').get(s.name) as
    | { id: string; version: number }
    | null;

  if (existing) {
    db.prepare(`
      UPDATE skills
      SET app = ?, description = ?, match_json = ?, params_json = ?, steps_json = ?,
          provenance = ?, version = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      s.app ?? '',
      s.description ?? '',
      JSON.stringify(s.match ?? {}),
      JSON.stringify(s.params ?? []),
      JSON.stringify(s.steps),
      s.provenance ?? 'authored',
      s.version ?? existing.version + 1,
      (s.enabled ?? true) ? 1 : 0,
      now,
      existing.id,
    );
    return getSkill(existing.id)!;
  }

  const id = generateId();
  db.prepare(`
    INSERT INTO skills (id, name, app, description, match_json, params_json, steps_json,
                        provenance, version, enabled, success_count, run_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    id,
    s.name,
    s.app ?? '',
    s.description ?? '',
    JSON.stringify(s.match ?? {}),
    JSON.stringify(s.params ?? []),
    JSON.stringify(s.steps),
    s.provenance ?? 'authored',
    s.version ?? 1,
    (s.enabled ?? true) ? 1 : 0,
    now,
    now,
  );
  return getSkill(id)!;
}

export function getSkill(id: string): Skill | null {
  const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | null;
  return row ? rowToSkill(row) : null;
}

export function getSkillByName(name: string): Skill | null {
  const row = getDb().prepare('SELECT * FROM skills WHERE name = ? COLLATE NOCASE').get(name) as SkillRow | null;
  return row ? rowToSkill(row) : null;
}

export function listSkills(enabledOnly = true): Skill[] {
  const sql = enabledOnly
    ? 'SELECT * FROM skills WHERE enabled = 1 ORDER BY name'
    : 'SELECT * FROM skills ORDER BY name';
  return (getDb().prepare(sql).all() as SkillRow[]).map(rowToSkill);
}

export function deleteSkill(id: string): void {
  getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
}

/** Record a run outcome for the successRate signal. */
export function recordSkillRun(id: string, success: boolean): void {
  getDb().prepare(`
    UPDATE skills
    SET run_count = run_count + 1,
        success_count = success_count + ?,
        verified_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(success ? 1 : 0, success ? Date.now() : null, Date.now(), id);
}

/**
 * Match skills against a message + optional active-app context. Union of
 * keyword, domain, and process-name matches (case-insensitive substring).
 * This is the URL/active-tab-aware matching the audit found missing from
 * webapp_templates.
 */
export function matchSkills(
  message: string,
  ctx: { url?: string; processName?: string } = {},
): Skill[] {
  const msg = message.toLowerCase();
  const url = (ctx.url ?? '').toLowerCase();
  const proc = (ctx.processName ?? '').toLowerCase();

  return listSkills(true).filter((s) => {
    const nameHit = msg.includes(s.name.toLowerCase()) || (s.app && msg.includes(s.app.toLowerCase()));
    const kwHit = (s.match.keywords ?? []).some((k) => msg.includes(k.toLowerCase()));
    const domainHit = url !== '' && (s.match.domains ?? []).some((d) => url.includes(d.toLowerCase()));
    const procHit = proc !== '' && (s.match.processNames ?? []).some((p) => proc.includes(p.toLowerCase()));
    return nameHit || kwHit || domainHit || procHit;
  });
}
