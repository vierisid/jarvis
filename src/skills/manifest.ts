/**
 * Skill marketplace — export/import via a signed manifest.
 *
 * A skill is exported as a self-describing manifest with a content hash so a
 * consumer can detect tampering/corruption in transit. Imported skills are
 * marked provenance:'marketplace' and are NEVER auto-trusted: they run under
 * the Authority engine + ledger like any other skill, and their successRate is
 * surfaced so the user can judge them (System 2 dependency).
 *
 * "Signed" here means content-integrity (hash over the canonical payload).
 * Publisher-identity signatures (asymmetric keys) are a later add-on; the
 * manifest carries an optional `publisher` + `signature` passthrough for that.
 */

import { createHash } from 'node:crypto';
import type { Skill, SkillMatch, SkillParam, SkillStep } from './types.ts';
import { upsertSkill, getSkillByName, type UpsertSkill } from '../vault/skills.ts';

export const MANIFEST_VERSION = 1;

export type SkillManifest = {
  manifestVersion: number;
  name: string;
  app: string;
  description: string;
  match: SkillMatch;
  params: SkillParam[];
  steps: SkillStep[];
  /** Reliability signal from the exporter, informational only. */
  successRate?: number;
  runCount?: number;
  /** Optional publisher identity (not verified here). */
  publisher?: string;
  signature?: string;
  /** sha256 over the canonical payload (everything except this field). */
  contentHash: string;
};

/** Deterministic JSON for hashing: sorted keys, stable across runs. */
function canonical(obj: unknown): string {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((obj as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj ?? null);
}

function hashPayload(payload: Omit<SkillManifest, 'contentHash'>): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/** Export a stored skill to a shareable manifest. */
export function exportSkill(skill: Skill, publisher?: string): SkillManifest {
  const payload: Omit<SkillManifest, 'contentHash'> = {
    manifestVersion: MANIFEST_VERSION,
    name: skill.name,
    app: skill.app,
    description: skill.description,
    match: skill.match,
    params: skill.params,
    steps: skill.steps,
    successRate: skill.runCount > 0 ? skill.successCount / skill.runCount : undefined,
    runCount: skill.runCount,
    publisher,
  };
  return { ...payload, contentHash: hashPayload(payload) };
}

export function serializeManifest(m: SkillManifest): string {
  return JSON.stringify(m, null, 2);
}

export type ImportResult =
  | { ok: true; skill: Skill; renamedFrom?: string }
  | { ok: false; error: string };

/**
 * Import a manifest into the skill store. Verifies the content hash, rejects
 * unknown manifest versions, and marks the skill provenance:'marketplace'.
 * If a skill of the same name exists, the import is stored under a suffixed
 * name (never silently overwrites a local/recorded skill). The runCount/
 * successCount reset to 0 locally — the exporter's stats are informational,
 * not inherited trust.
 */
export function importSkill(manifest: SkillManifest, opts: { overwrite?: boolean } = {}): ImportResult {
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    return { ok: false, error: `unsupported manifest version ${manifest.manifestVersion} (this build supports ${MANIFEST_VERSION})` };
  }
  const { contentHash, ...payload } = manifest;
  if (hashPayload(payload) !== contentHash) {
    return { ok: false, error: 'content hash mismatch — the manifest was modified or corrupted in transit; not importing' };
  }
  if (!manifest.name || !Array.isArray(manifest.steps) || manifest.steps.length === 0) {
    return { ok: false, error: 'manifest has no name or no steps' };
  }

  let name = manifest.name;
  let renamedFrom: string | undefined;
  if (!opts.overwrite && getSkillByName(name)) {
    renamedFrom = name;
    let n = 2;
    while (getSkillByName(`${name}-${n}`)) n++;
    name = `${name}-${n}`;
  }

  const toStore: UpsertSkill = {
    name,
    app: manifest.app,
    description: manifest.description,
    match: manifest.match,
    params: manifest.params,
    steps: manifest.steps,
    provenance: 'marketplace',
  };
  const skill = upsertSkill(toStore);
  return { ok: true, skill, renamedFrom };
}
