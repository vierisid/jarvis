import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { containedFile, discover, ROOT } from './discovery';
import { requiredCases } from './matrix';
import { artifact, evidenceIndex, same, sourceCandidate, verifyReport } from './report';
import type { Candidate, Observation, Report } from './types';

export async function child(command: string[], cwd: string, timeoutMs = 180000) {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...Bun.env, NO_COLOR: '1' } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; process.kill('SIGKILL'); }, timeoutMs);
  try { const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]); return { code, timedOut, output: stdout + '\n' + stderr }; }
  finally { clearTimeout(timer); }
}
export function suiteVerdict(result: { code: number; timedOut: boolean; output: string }) {
  const count = (name: string) => Number(result.output.match(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, 'm'))?.[1] ?? 0);
  const passed = count('pass'), failed = count('fail'), skipped = count('skip');
  const outcome = result.code !== 0 || result.timedOut || failed ? 'failed' : !passed || skipped ? 'blocked' : 'passed';
  return { outcome, reason: `${passed} passed, ${failed} failed, ${skipped} skipped; exit ${result.code}${result.timedOut ? '; timed out' : ''}.` } as const;
}
export async function run(directory: string, options: { root?: string; only?: string; frontend?: string; sidecar?: string } = {}) {
  const root = options.root ?? ROOT, output = resolve(directory), inside = relative(root, output);
  if (!(inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))) throw Error('Evidence must be outside the source checkout.');
  const required = requiredCases();
  if (options.only && !required.some(c => c.id === options.only)) throw Error('Unknown case');
  await mkdir(output); // Never overwrite or reuse prior evidence/databases.
  const candidate = await sourceCandidate(root, options.frontend, options.sidecar), inventory = await discover(root);
  const report: Report = { schemaVersion: 1, candidate, inventory, cases: [], gates: [] };
  await writeFile(resolve(output, 'candidate.json'), JSON.stringify(candidate));
  for (const spec of required) {
    const row: Report['cases'][number] = { id: spec.id, outcome: 'blocked', reason: 'Not executed.', evidence: [] };
    report.cases.push(row);
    const missing = spec.requires.filter(id => !inventory.present.includes(id));
    if (missing.length) { row.reason = `Unavailable modules: ${missing.join(', ')}.`; continue; }
    if (options.only && options.only !== spec.id) { row.reason = 'Outside requested replay; required case retained.'; continue; }
    if (spec.kind !== 'mocked') { row.reason = spec.kind === 'manual' ? 'Actual staging/browser/native observation unavailable; manual evidence required.' : 'Supported staging profile registry, prior spend approval and live model evidence required; no paid run attempted.'; continue; }
    const folder = spec.id.replaceAll('/', '--'), caseDir = resolve(output, folder); await mkdir(caseDir);
    try {
      if (spec.suites) for (const file of spec.suites) await containedFile(root, file);
      const result = await child(spec.suites ? [process.execPath, 'test', ...spec.suites] : [process.execPath, await containedFile(root, 'src/onboarding-next/verification/worker.ts'), spec.id, caseDir, resolve(output, 'candidate.json')], root);
      await writeFile(resolve(caseDir, 'run.log'), result.output);
      row.evidence.push(await artifact(output, `${folder}/run.log`));
      if (spec.suites) {
        Object.assign(row, suiteVerdict(result));
        const observation: Observation = { schemaVersion: 1, candidate, caseId: spec.id, kind: 'mocked', observedAt: new Date().toISOString(), artifacts: [...row.evidence],
          checks: spec.checks.map(id => ({ id, passed: row.outcome === 'passed' })), details: { command: ['bun','test',...spec.suites], result: row.reason, scope: 'Owner regression suites; deterministic fixtures, not deployed device/provider proof.' } };
        await writeFile(resolve(caseDir, 'case.observation.json'), JSON.stringify(observation,null,2));
      } else {
        row.outcome = result.code === 0 && !result.timedOut ? 'passed' : 'failed';
        row.reason = row.outcome === 'passed' ? 'Actual providers/SQLite assertions passed with deterministic leaf services; disabled draft or truthful no-draft recovery, zero network/run effects.' : `Scenario failed (exit ${result.code}, timeout ${result.timedOut}); inspect log.`;
        if (row.outcome === 'passed') row.evidence.push(await artifact(output, `${folder}/saved.sqlite`));
      }
      if (row.outcome !== 'failed' || spec.suites) row.evidence.push(await artifact(output, `${folder}/case.observation.json`));
    } catch (error: any) { row.outcome = error.code === 'ENOENT' ? 'blocked' : 'failed'; row.reason = String(error); }
  }
  const after = await sourceCandidate(root, options.frontend, options.sidecar);
  if (!same(after, candidate)) report.candidate.dirty = true;
  const verdict = await verifyReport(report, output, after, root);
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report,null,2));
  await writeFile(resolve(output, 'verdict.json'), JSON.stringify(verdict,null,2));
  await writeFile(resolve(output, 'index.html'), evidenceIndex(report, verdict));
  return { report, verdict };
}
