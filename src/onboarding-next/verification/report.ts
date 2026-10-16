import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { containedFile, ROOT } from './discovery';
import { PROVIDERS, RELEASE_OWNERS, requiredCases, VIEWS } from './matrix';
import type { Artifact, Candidate, Report } from './types';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sha = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const nonempty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const validDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
export const validCandidate = (c: any): c is Candidate => !!c && ['backend','frontend','sidecar','tree'].every(k => sha(c[k])) && c.dirty === false;
// Hooks export GIT_DIR/GIT_INDEX_FILE; never let them redirect another checkout's
// identity reads (or the temporary repositories used by regression tests).
export const gitEnvironment = () => Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith('GIT_')));
export async function sourceCandidate(root = ROOT, frontend?: string, sidecar?: string): Promise<Candidate> {
  const git = (args: string[]) => { const p = Bun.spawnSync(['git', ...args], { cwd: root, env: gitEnvironment() }); if (p.exitCode) throw Error('Cannot read candidate Git identity'); return p.stdout.toString().trim(); };
  const backend = git(['rev-parse','HEAD']);
  return { backend, frontend: frontend ?? backend, sidecar: sidecar ?? backend, tree: git(['rev-parse','HEAD^{tree}']), dirty: !!git(['status','--porcelain','--untracked-files=all']) };
}
export async function artifact(directory: string, path: string): Promise<Artifact> { return { path, sha256: hash(await readFile(await containedFile(directory, path))) }; }
export async function readArtifact(directory: string, item: Artifact, json = false) {
  if (!item || !/^[a-f0-9]{64}$/.test(item.sha256)) throw Error('Invalid artifact digest');
  const file = await containedFile(directory, item.path), size = (await stat(file)).size;
  if (!size || size > 64 * 1024 * 1024) throw Error('Empty/oversized artifact');
  const bytes = await readFile(file); if (hash(bytes) !== item.sha256) throw Error(`Changed artifact: ${item.path}`);
  return json ? JSON.parse(bytes.toString()) : bytes;
}
/** Owner receipts bind the entire evidence set, excluding the receipts themselves.
 * The release-owner receipt additionally binds the five other owner receipts. */
export function evidenceDigest(report: Report) {
  return hash(canonical({ schemaVersion: report.schemaVersion, candidate: report.candidate, inventory: report.inventory,
    cases: [...report.cases].sort((a,b) => a.id.localeCompare(b.id)), visual: report.visual ?? null, staging: report.staging ?? null }));
}
export function ownersDigest(report: Report) { return hash(canonical(report.gates.filter(g => g.owner !== 'release-owner').sort((a,b) => a.owner.localeCompare(b.owner)))); }

export async function verifyReport(report: Report, directory: string, expected: Candidate, frontendRoot = ROOT) {
  const errors: string[] = [], blockers: string[] = [], counts = { passed: 0, failed: 0, blocked: 0, not_run: 0 };
  const required = requiredCases(), known = new Map(required.map(c => [c.id, c]));
  const check = (ok: unknown, message: string) => { if (!ok) errors.push(message); };
  try {
    check(report?.schemaVersion === 1 && validCandidate(report.candidate) && validCandidate(expected) && same(report.candidate, expected), 'Candidate must match the clean expected backend/frontend/sidecar SHA and backend tree.');
    const owners = [...PROVIDERS.map(p => p[0]), ...VIEWS.map((_,n) => `ON-U-${String(n+1).padStart(2,'0')}`), 'ON-U-10','ON-U-11','ON-B-11'];
    const inventory = report.inventory;
    check(Array.isArray(inventory?.present) && Array.isArray(inventory?.missing) && same([...inventory.present, ...inventory.missing].sort(), [...owners].sort()), 'Invalid module inventory.');
    if (inventory.missing.length) blockers.push(`Release closure absent: ${inventory.missing.join(', ')}.`);
    const seen = new Set<string>(); let totalSpend = 0, latestObservationAt = 0;
    for (const row of report.cases) {
      const spec = known.get(row.id); check(spec && !seen.has(row.id), `Unknown/duplicate case: ${row.id}`); seen.add(row.id);
      check(Object.hasOwn(counts, row.outcome), `Invalid outcome: ${row.id}`);
      if (Object.hasOwn(counts, row.outcome)) counts[row.outcome]++;
      check(nonempty(row.reason) && Array.isArray(row.evidence), `Missing observation: ${row.id}`);
      if (row.outcome !== 'passed') blockers.push(`${row.id}: ${row.outcome}`);
      if (row.outcome === 'passed' && spec) {
        check(spec.requires.every(id => inventory.present.includes(id)), `Absent provider passed: ${row.id}`);
        check(row.evidence.length > 0, `Missing evidence: ${row.id}`);
      }
      let observations = 0;
      for (const item of row.evidence) {
        try {
          const bytes = await readArtifact(directory, item);
          if (!item.path.endsWith('.observation.json')) continue;
          observations++; const data = JSON.parse(bytes.toString());
          check(data.schemaVersion === 1 && data.caseId === row.id && same(data.candidate, report.candidate) && data.kind === spec?.kind, `Stale/wrong observation: ${row.id}`);
          check(validDate(data.observedAt) && data.details && Array.isArray(data.artifacts) && data.artifacts.length > 0, `Incomplete observation: ${row.id}`);
          if (validDate(data.observedAt)) latestObservationAt = Math.max(latestObservationAt, Date.parse(data.observedAt));
          for (const ref of data.artifacts ?? []) { check(row.evidence.some(e => same(e, ref)), `Unlisted observation artifact: ${row.id}`); await readArtifact(directory, ref); }
          if (row.outcome === 'passed') {
            check(Array.isArray(data.checks) && same(data.checks.map((c: any) => c.id).sort(), [...(spec?.checks ?? [])].sort()) && data.checks.every((c: any) => c.passed === true), `Required assertions not passed: ${row.id}`);
            if (spec?.kind !== 'mocked') check(nonempty(data.environment), `Missing actual environment: ${row.id}`);
            if (spec?.kind === 'real-provider') {
              check(!!report.staging, `Missing staging authorization: ${row.id}`);
              const profiles = data.profiles;
              check(Array.isArray(profiles) && profiles.length > 0 && same(profiles.map((p: any) => ({ id: p.id, version: p.version })).sort((a: any,b: any) => a.id.localeCompare(b.id)), [...(report.staging?.profiles ?? [])].sort((a,b) => a.id.localeCompare(b.id))), `Unsupported/incomplete profile coverage: ${row.id}`);
              for (const p of profiles ?? []) { check(p.outcome === 'passed' && Number.isFinite(p.spendUsd) && p.spendUsd >= 0, `Invalid provider result/spend: ${row.id}`); totalSpend += p.spendUsd; }
              if (report.staging) { const approval = await readArtifact(directory, report.staging.spendApproval, true); check(validDate(approval.approvedAt) && Date.parse(approval.approvedAt) <= Date.parse(data.observedAt), `Spend was not authorized before run: ${row.id}`); }
            }
          }
        } catch (error) { errors.push(`${row.id}: ${String(error)}`); }
      }
      if (row.outcome === 'passed') check(observations === 1, `Exactly one bound observation required: ${row.id}`);
    }
    for (const spec of required) if (!seen.has(spec.id)) errors.push(`Missing case: ${spec.id}`);
    if (report.staging) {
      const s = report.staging;
      check(s.profiles.length > 0 && s.profiles.every(p => nonempty(p.id) && nonempty(p.version)) && new Set(s.profiles.map(p => p.id)).size === s.profiles.length, 'Invalid supported profile list.');
      const registry = await readArtifact(directory, s.registry, true), approval = await readArtifact(directory, s.spendApproval, true);
      check(same(registry.candidate, expected) && same(registry.profiles, s.profiles) && nonempty(registry.environment) && nonempty(registry.verifiedBy), 'Stale/missing authoritative staging profile registry.');
      check(same(approval.candidate, expected) && same(approval.profiles, s.profiles) && approval.approved === true && nonempty(approval.approvedBy) && validDate(approval.approvedAt) && Number.isFinite(approval.budgetUsd) && approval.budgetUsd > 0 && totalSpend <= approval.budgetUsd, 'Invalid/overspent staging authorization.');
    }
    if (!report.visual) blockers.push('ON-U-11 candidate evidence missing.');
    else {
      const visual = await readArtifact(directory, report.visual, true);
      const source = await sourceCandidate(frontendRoot);
      check(source.backend === expected.frontend && source.tree === visual.candidate?.tree && !source.dirty, 'U11 verifier source must be the clean exact frontend candidate.');
      if (source.backend === expected.frontend && !source.dirty) {
        const api = await import(await containedFile(frontendRoot, 'ui/src/onboarding-next/verification/report.ts'));
        const assessment = api.assess(visual, expected.frontend);
        errors.push(...assessment.errors.map((e: string) => `U11: ${e}`));
        errors.push(...(await api.verifyArtifacts(visual, dirname(await containedFile(directory, report.visual.path)))).map((e: string) => `U11: ${e}`));
        // U11 and B13 form one joint decision. Only the absent B13 gate may be
        // pending here; a malformed/stale B13 gate is still an error above.
        if (assessment.scope !== 'runtime' || assessment.counts.passed !== assessment.required || assessment.missingGates.some((g: string) => g !== 'ON-B-13')) blockers.push('ON-U-11 runtime acceptance incomplete.');
      }
    }
    const gates = new Set<string>(), approvalTimes = new Map<string,number>();
    for (const gate of report.gates) {
      check((RELEASE_OWNERS as readonly string[]).includes(gate.owner) && !gates.has(gate.owner), `Unknown/duplicate gate: ${gate.owner}`); gates.add(gate.owner);
      const receipt = await readArtifact(directory, gate.receipt, true);
      check(receipt.schemaVersion === 1 && receipt.owner === gate.owner && same(receipt.candidate, expected) && receipt.approved === true && nonempty(receipt.approvedBy) && validDate(receipt.approvedAt) && nonempty(receipt.observations) && receipt.evidenceDigest === evidenceDigest(report), `Unapproved/stale gate: ${gate.owner}`);
      check(Date.parse(receipt.approvedAt) >= latestObservationAt, `Owner approval predates observations: ${gate.owner}`);
      approvalTimes.set(gate.owner, Date.parse(receipt.approvedAt));
      check(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, `Missing gate source evidence: ${gate.owner}`);
      for (const item of receipt.artifacts ?? []) await readArtifact(directory, item);
      if (gate.owner === 'release-owner') check(receipt.ownersDigest === ownersDigest(report), 'Release owner did not approve these owner decisions.');
    }
    for (const owner of RELEASE_OWNERS) if (!gates.has(owner)) blockers.push(`${owner} approval missing.`);
    if (approvalTimes.has('release-owner')) check([...approvalTimes.values()].every(time => time <= approvalTimes.get('release-owner')!), 'Release owner approval predates another owner decision.');
  } catch (error) { errors.push(`Invalid report/evidence: ${String(error)}`); }
  return { releaseReady: !errors.length && !blockers.length && counts.passed === required.length, required: required.length, counts, errors, blockers };
}

const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
export function evidenceIndex(report: Report, verdict: Awaited<ReturnType<typeof verifyReport>>) {
  return `<!doctype html><meta charset="utf-8"><title>ON-B-13 evidence</title><style>body{font:16px system-ui;max-width:1200px;margin:40px auto;padding:20px;color:#17212b;background:#f8f9fb}td,th{border:1px solid #bbb;padding:10px;text-align:left;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}</style><h1>Onboarding functional acceptance</h1><p>Release ${verdict.releaseReady ? 'evidence complete — separate deployment approval required' : 'BLOCKED'}. This command never changes production.</p><pre>${escape(JSON.stringify(report.candidate,null,2))}</pre><p>${escape(JSON.stringify(verdict.counts))} / ${verdict.required} required. Automated fixtures use actual providers and SQLite with mocked leaf services. Manual and real-provider checks stay blocked until supplied for this exact candidate.</p><p><a href="report.json">Report</a> · <a href="verdict.json">Verified decision</a></p><p>Replay: <code>bun src/onboarding-next/verification/cli.ts run --out /tmp/fresh-replay --case journey/hosted</code>; use <code>recovery/crash-after-save</code> for durable reconciliation. Inspect the linked SQLite fixture and exact graph trace.</p><table><tr><th>Case / evidence class</th><th>Result</th><th>Observation</th><th>Artifacts</th></tr>${report.cases.map(row => `<tr><td>${escape(row.id)}<br>${escape(requiredCases().find(c => c.id === row.id)?.kind)}</td><td>${escape(row.outcome)}</td><td>${escape(row.reason)}</td><td>${row.evidence.map(e => `<a href="${escape(e.path)}">${escape(e.path)}</a>`).join('<br>')}</td></tr>`).join('')}</table>`;
}
