/**
 * Skills store: vault persistence for parameterized, verified procedures.
 * Replaces the markdown webapp_templates store (which coexists during
 * migration). See src/skills/types.ts for the model.
 *
 * INTEGRITY. Every row carries `content_mac`, an HMAC-SHA256 over the
 * reviewed content (name, app, description, match, params, steps,
 * provenance, version, enabled) keyed by a per-install secret in the
 * keychain. `run_skill` replays a skill only when the MAC verifies, so a
 * database writer without the key cannot rewrite a skill's steps, re-label
 * its provenance, or swap one skill's content into another's row and have it
 * run. Run counters live outside the MAC because recording a run must not
 * need the key. A row with no MAC (written before signing existed) reads as
 * `unsigned` and is treated like a tampered one: listed, never run.
 *
 * Same shape as the row-bound credential envelope proposed in #481: the
 * store binds content to its row and refuses what it cannot authenticate.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb, generateId } from './schema.ts';
import { getSecret, setSecret } from './keychain.ts';
import type { Skill, SkillIntegrity, SkillMatch, SkillParam, SkillStep } from '../skills/types.ts';

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
  content_mac: string | null;
  success_count: number;
  run_count: number;
  verified_at: number | null;
  created_at: number;
  updated_at: number;
};

const SIGNING_SECRET_NAME = 'skill_signing_key';
let signingKey: Buffer | null = null;

/**
 * The per-install signing key, created on first use and kept in the
 * keychain next to the other daemon secrets.
 */
function getSigningKey(): Buffer {
  if (signingKey) return signingKey;
  const stored = getSecret(SIGNING_SECRET_NAME);
  if (stored && /^[0-9a-f]{64}$/.test(stored)) {
    signingKey = Buffer.from(stored, 'hex');
    return signingKey;
  }
  const fresh = randomBytes(32);
  setSecret(SIGNING_SECRET_NAME, fresh.toString('hex'));
  signingKey = fresh;
  return fresh;
}

/** Test seam: pin the signing key so tests never touch the real keychain. */
export function setSkillSigningKey(key: Buffer | null): void {
  signingKey = key;
}

type SignedFields = Pick<SkillRow, 'id' | 'name' | 'app' | 'description' | 'match_json' | 'params_json' | 'steps_json' | 'provenance' | 'version' | 'enabled'>;

function contentMac(f: SignedFields): string {
  const canonical = JSON.stringify([
    f.id, f.name, f.app, f.description, f.match_json, f.params_json, f.steps_json, f.provenance, f.version, f.enabled,
  ]);
  return createHmac('sha256', getSigningKey()).update(canonical).digest('hex');
}

function integrityOf(row: SkillRow): SkillIntegrity {
  if (!row.content_mac) return 'unsigned';
  const expected = Buffer.from(contentMac(row), 'hex');
  const actual = /^[0-9a-f]{64}$/.test(row.content_mac) ? Buffer.from(row.content_mac, 'hex') : Buffer.alloc(0);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? 'ok' : 'tampered';
}

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
    integrity: integrityOf(row),
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

/**
 * Insert or update a skill by name, signing the stored content. An update
 * bumps the version. This is the only write path for skill content; the
 * record_skill tool refuses to update an existing name (see skills.ts), so
 * updates here come from seeds and tests.
 */
export function upsertSkill(s: UpsertSkill): Skill {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare('SELECT id, version FROM skills WHERE name = ?').get(s.name) as
    | { id: string; version: number }
    | null;

  const fields: SignedFields = {
    id: existing?.id ?? generateId(),
    name: s.name,
    app: s.app ?? '',
    description: s.description ?? '',
    match_json: JSON.stringify(s.match ?? {}),
    params_json: JSON.stringify(s.params ?? []),
    steps_json: JSON.stringify(s.steps),
    provenance: s.provenance ?? 'authored',
    version: s.version ?? (existing ? existing.version + 1 : 1),
    enabled: (s.enabled ?? true) ? 1 : 0,
  };
  const mac = contentMac(fields);

  if (existing) {
    db.prepare(`
      UPDATE skills
      SET app = ?, description = ?, match_json = ?, params_json = ?, steps_json = ?,
          provenance = ?, version = ?, enabled = ?, content_mac = ?, updated_at = ?
      WHERE id = ?
    `).run(
      fields.app, fields.description, fields.match_json, fields.params_json, fields.steps_json,
      fields.provenance, fields.version, fields.enabled, mac, now, existing.id,
    );
    return getSkill(existing.id)!;
  }

  db.prepare(`
    INSERT INTO skills (id, name, app, description, match_json, params_json, steps_json,
                        provenance, version, enabled, content_mac, success_count, run_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    fields.id, fields.name, fields.app, fields.description, fields.match_json, fields.params_json, fields.steps_json,
    fields.provenance, fields.version, fields.enabled, mac, now, now,
  );
  return getSkill(fields.id)!;
}

export function getSkill(id: string): Skill | null {
  const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | null;
  return row ? rowToSkill(row) : null;
}

export function getSkillByName(name: string): Skill | null {
  const row = getDb().prepare('SELECT * FROM skills WHERE name = ? COLLATE NOCASE').get(name) as SkillRow | null;
  return row ? rowToSkill(row) : null;
}

/** Every stored skill, including ones whose integrity check failed; callers filter. */
export function listSkills(enabledOnly = true): Skill[] {
  const sql = enabledOnly
    ? 'SELECT * FROM skills WHERE enabled = 1 ORDER BY name'
    : 'SELECT * FROM skills ORDER BY name';
  return (getDb().prepare(sql).all() as SkillRow[]).map(rowToSkill);
}

/** Enabled skills that verify; the only ones advertised to the model or run. */
export function listRunnableSkills(): Skill[] {
  return listSkills(true).filter((s) => s.integrity === 'ok');
}

export function deleteSkill(id: string): void {
  getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
}

/** Record a run outcome for the successRate signal. Outside the MAC by design. */
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
 * Match runnable skills against a message + optional active-app context.
 * Union of name, keyword, domain, and process-name matches (case-insensitive
 * substring). Drives the ordering of the prompt index: matched skills first.
 */
export function matchSkills(
  message: string,
  ctx: { url?: string; processName?: string } = {},
): Skill[] {
  const msg = message.toLowerCase();
  const url = (ctx.url ?? '').toLowerCase();
  const proc = (ctx.processName ?? '').toLowerCase();

  return listRunnableSkills().filter((s) => {
    const nameHit = msg.includes(s.name.toLowerCase()) || (s.app !== '' && msg.includes(s.app.toLowerCase()));
    const kwHit = (s.match.keywords ?? []).some((k) => msg.includes(k.toLowerCase()));
    const domainHit = url !== '' && (s.match.domains ?? []).some((d) => url.includes(d.toLowerCase()));
    const procHit = proc !== '' && (s.match.processNames ?? []).some((p) => proc.includes(p.toLowerCase()));
    return nameHit || kwHit || domainHit || procHit;
  });
}
