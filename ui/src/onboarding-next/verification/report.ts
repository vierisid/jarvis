import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { FIGMA, GATES, VIEWS, requiredCases } from './matrix';
import type { Inventory } from './discovery';
export interface Candidate { revision: string; tree: string; dirty: boolean; }
export interface Row { id: string; revision: string; outcome: 'passed' | 'failed' | 'blocked' | 'not_run'; reason: string; evidence: { path: string; sha256: string }[]; }
export interface Report { schemaVersion: 1; candidate: Candidate; scope: 'fixture' | 'runtime'; inventory: Inventory; cases: Row[]; gates: { owner: string; revision: string; outcome: Row['outcome']; evidence: Row['evidence'] }[]; }
export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const safePath = (path: unknown): path is string => typeof path === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(path) && !path.split('/').some(p => p === '..' || p === '.' || !p);
export function blockReason(test: ReturnType<typeof requiredCases>[number], inventory: Inventory) {
  if (test.view === 'journey') return !inventory.host ? 'ON-U-10 assembly is absent.' : inventory.missing.length ? `Missing views: ${inventory.missing.join(', ')}` : null;
  if (!inventory.views.includes(test.view)) return `${test.owner} view is absent.`;
  if (test.view === 'pebble-tour' && test.state !== 'unavailable' && !inventory.pebble) return 'D06 Pebble surface is absent.';
  if (test.view === 'result' && ['ready', 'review', 'needs_input', 'long'].includes(test.state)) return 'Actual D18 renderer binding is absent from this fixture; no replacement canvas is accepted.';
  if (test.kind !== 'layout' && test.kind !== 'keyboard') return `${test.kind} requires candidate-bound runtime or human evidence; DOM fixtures alone cannot pass it.`;
  return null;
}
export function complete(report: Report): Report {
  const known = new Set(report.cases.map(row => row.id));
  return { ...report, cases: [...report.cases, ...requiredCases().filter(test => !known.has(test.id)).map(test => ({ id: test.id, revision: report.candidate.revision, outcome: 'blocked' as const,
    reason: blockReason(test, report.inventory) ?? 'Not executed; evidence required.', evidence: [] }))] };
}
export function assess(report: Report, expectedRevision: string) {
  const errors: string[] = [], required = new Map(requiredCases().map(c => [c.id, c]));
  const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
  if (report.schemaVersion !== 1 || !sha(expectedRevision) || report.candidate?.revision !== expectedRevision || !sha(report.candidate?.tree) || report.candidate?.dirty !== false) errors.push('Candidate must be a clean exact Git revision/tree.');
  if (!['fixture', 'runtime'].includes(report.scope)) errors.push('Invalid evidence scope.');
  if (!report.inventory || !Array.isArray(report.inventory.views) || typeof report.inventory.host !== 'boolean' || typeof report.inventory.pebble !== 'boolean') throw Error('Invalid discovery inventory');
  const discovered = report.inventory.views;
  if (new Set(discovered).size !== discovered.length || discovered.some(name => !VIEWS.some(view => view.name === name)) || JSON.stringify(report.inventory.missing) !== JSON.stringify(VIEWS.filter(view => !discovered.includes(view.name)).map(view => view.id))) errors.push('Discovery inventory is inconsistent.');
  const seen = new Set<string>(), counts = { passed: 0, failed: 0, blocked: 0, not_run: 0 };
  for (const row of report.cases ?? []) {
    const test = required.get(row.id);
    if (!test || seen.has(row.id)) errors.push(`Unknown/duplicate case: ${row.id}`);
    seen.add(row.id);
    if (row.revision !== expectedRevision) errors.push(`Stale evidence: ${row.id}`);
    if (!Object.hasOwn(counts, row.outcome)) errors.push(`Invalid outcome: ${row.id}`); else counts[row.outcome]++;
    if (typeof row.reason !== 'string' || !row.reason.trim()) errors.push(`Missing observation: ${row.id}`);
    if (!Array.isArray(row.evidence) || (row.outcome === 'passed' && !row.evidence.length)) errors.push(`Missing evidence: ${row.id}`);
    if (test && row.outcome === 'passed') {
      const paths = (row.evidence ?? []).map(e => e.path);
      const suffix = test.kind === 'journey' ? '.trace.json' : ['layout','keyboard'].includes(test.kind) ? '.metrics.json' : '.review.json';
      if (!paths.some(p => p.endsWith('.png')) || !paths.some(p => p.endsWith(suffix))) errors.push(`Required screenshot/observation missing: ${row.id}`);
      if (report.scope === 'fixture' && test.kind === 'layout' && blockReason(test, report.inventory)) errors.push(`Unbound fixture passed: ${row.id}`);
    }
    if (test && row.outcome === 'passed' && !report.inventory.views.includes(test.view) && test.view !== 'journey') errors.push(`Absent view passed: ${row.id}`);
    if (test?.kind === 'journey' && row.outcome === 'passed' && (!report.inventory.host || report.inventory.missing.length)) errors.push(`Absent assembly passed: ${row.id}`);
  }
  for (const id of required.keys()) if (!seen.has(id)) errors.push(`Missing case: ${id}`);
  const gateOwners = new Set<string>();
  for (const gate of report.gates ?? []) {
    if (!(GATES as readonly string[]).includes(gate.owner) || gateOwners.has(gate.owner)) errors.push(`Unknown/duplicate gate: ${gate.owner}`);
    gateOwners.add(gate.owner);
    if (gate.revision !== expectedRevision || gate.outcome !== 'passed' || !gate.evidence?.length) errors.push(`Gate not verified: ${gate.owner}`);
  }
  const missingGates = GATES.filter(owner => !gateOwners.has(owner));
  const releaseReady = report.scope === 'runtime' && errors.length === 0 && counts.passed === required.size && missingGates.length === 0;
  return { releaseReady, scope: report.scope, required: required.size, counts, errors, missingGates };
}
export async function verifyArtifacts(report: Report, directory: string) {
  const errors: string[] = [], root = await realpath(directory);
  for (const item of [...report.cases, ...(report.gates ?? [])]) for (const artifact of item.evidence ?? []) {
    try {
      if (!safePath(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw Error('Invalid artifact');
      const file = await realpath(resolve(root, artifact.path));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile() || !(await stat(file)).size || hash(await readFile(file)) !== artifact.sha256) throw Error('Artifact mismatch');
      if (/\.(metrics|trace|review)\.json$/.test(artifact.path)) {
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (!('id' in item) || data.caseId !== item.id || JSON.stringify(data.candidate) !== JSON.stringify(report.candidate)) throw Error('Evidence belongs to another case/candidate');
        if (artifact.path.endsWith('.metrics.json') && (data.metrics?.caseId !== item.id || data.metrics?.revision !== report.candidate.revision || !Array.isArray(data.errors) || (item.outcome === 'passed' && data.errors.length))) throw Error('Invalid measured observation');
        if (artifact.path.endsWith('.trace.json') && (!Array.isArray(data.trace) || !data.trace.length || !Array.isArray(data.errors) || (item.outcome === 'passed' && data.errors.length))) throw Error('Invalid journey trace');
        if (artifact.path.endsWith('.review.json') && (typeof data.environment !== 'string' || !data.environment.trim() || typeof data.observations !== 'string' || !data.observations.trim())) throw Error('Missing runtime review');
      }
      if ('owner' in item && artifact.path.endsWith('.json')) {
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (data.owner !== item.owner || data.revision !== report.candidate.revision || data.outcome !== item.outcome) throw Error('Stale gate receipt');
      }
    } catch { errors.push(`Missing/changed/unsafe evidence: ${artifact.path}`); }
  }
  return errors;
}
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function evidenceIndex(report: Report) {
  const assessment = assess(report, report.candidate.revision), matrix = new Map(requiredCases().map(c => [c.id, c]));
  return `<!doctype html><meta charset="utf-8"><title>ON-U-11 evidence</title><style>body{font:16px system-ui;max-width:1200px;margin:40px auto;padding:0 20px;background:#f8f9fb;color:#17212b}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd1d8;padding:10px;text-align:left;overflow-wrap:anywhere}h1{font-size:30px}.failed{background:#ffe1dd}.blocked,.not_run{background:#fff1ce}a{color:#164a9b}</style><h1>Onboarding visual acceptance</h1><p>Candidate ${escape(report.candidate.revision)} · ${escape(report.scope)} evidence · Release ${assessment.releaseReady ? 'ready (verify artifacts)' : 'BLOCKED'}</p><p>${escape(JSON.stringify(assessment.counts))} · Approved Figma checkpoint ${FIGMA.checkpoint}. Fixture results do not certify OAuth, models, permissions, native WebView or the D/F/Q release.</p><p><a href="report.json">Machine-readable report</a> · Replay on the running local fixture: ${['welcome-to-result','skip-connection-interview','failed-build-retry','tour-replay'].map(name => `<a href="http://127.0.0.1:4431/?journey=${name}">${name}</a>`).join(' · ')}</p><table><thead><tr><th>Owner / case</th><th>Outcome</th><th>Observation / bounded repair</th><th>Evidence</th></tr></thead><tbody>${report.cases.map(row => `<tr class="${escape(row.outcome)}"><td>${escape(matrix.get(row.id)?.owner ?? 'unknown')}<br>${escape(row.id)}</td><td>${escape(row.outcome)}</td><td>${escape(row.reason)}</td><td>${row.evidence.filter(e => safePath(e.path)).map(e => `<a href="${escape(e.path)}">${escape(e.path)}</a>`).join('<br>')}</td></tr>`).join('')}</tbody></table>`;
}
export async function writeReport(report: Report, directory: string) {
  const value = complete(report);
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(value, null, 2));
  await writeFile(resolve(directory, 'index.html'), evidenceIndex(value));
  return value;
}
