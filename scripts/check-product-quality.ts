#!/usr/bin/env bun
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assessProductQuality, hash, validRecord } from '../src/quality-release/assessment';
import { PROPOSED_SUPPLEMENT, releaseTemplate } from '../src/quality-release/template';

/** Read-only release audit. Runs only the fixed source probe suite on request;
 * never imports arbitrary executable adapters or invokes live providers. */
export function audit(args: string[], root = resolve(import.meta.dir, '..')): number {
  const options: Record<string, string> = {}; let probes = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--source-probes') { probes = true; continue; }
    if (!['--record', '--artifacts', '--out'].includes(key) || !args[i + 1] || args[i + 1]!.startsWith('--') || options[key]) throw new Error('invalid_arguments');
    options[key] = args[++i]!;
  }
  if (!options['--out']) throw new Error('output_required');
  const git = (...argv: string[]) => {
    const r = spawnSync('git', argv, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git_unavailable'); return r.stdout.trim();
  };
  const candidate = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=all').length > 0;
  const q01 = JSON.parse(readFileSync(join(root, 'src/workflows/evaluation/rubric/workflow-release-v1.json'), 'utf8'));
  const record: unknown = options['--record'] ? JSON.parse(readFileSync(resolve(options['--record']), 'utf8')) : releaseTemplate(candidate, hash(q01), {
    schema: hash(readFileSync(join(root, 'src/workflows/db/schema.ts'), 'utf8')),
    prompt: hash(readFileSync(join(root, 'src/actions/tools/composition-provenance.ts'), 'utf8')),
    catalog: hash({ status: 'unresolved' }), environment: hash({ status: 'source-only', bun: Bun.version }),
  });
  const artifacts = new Map<string, unknown>([[hash(q01), q01], [hash(PROPOSED_SUPPLEMENT), PROPOSED_SUPPLEMENT]]);
  if (validRecord(record) && options['--artifacts']) {
    const keys = [record.rubric.q01Hash, record.rubric.supplementHash,
      ...record.prerequisites.flatMap(r => r.proof ? [r.proof.artifact] : []),
      ...record.profiles.flatMap(p => [...p.journeys, ...p.quality, p.liveConnector].flatMap(r => r.proof ? [r.proof.artifact] : []))];
    for (const key of new Set(keys)) {
      // key is validated as hex; never use an arbitrary path from an evidence row.
      try { artifacts.set(key, JSON.parse(readFileSync(join(resolve(options['--artifacts']), key + '.json'), 'utf8'))); } catch { /* missing is blocked below */ }
    }
  }
  const scorecard = assessProductQuality(record, candidate, new Date(), artifacts);
  const blockers = [...scorecard.blockers, ...(dirty ? ['dirty_candidate'] : [])];
  if (validRecord(record)) for (const row of record.prerequisites.filter(r => r.disposition === 'passed')) {
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', row.integratedHead, candidate], { cwd: root });
    if (ancestry.status !== 0) blockers.push('source_not_integrated:' + row.card);
  }
  let sourceProbes: { disposition: string; scope: string; logSha256?: string } = { disposition: 'not_run', scope: 'source-stubs-only' };
  if (probes) {
    const scratch = mkdtempSync(join(tmpdir(), 'q22-probe-'));
    try {
      const run = spawnSync(process.execPath, ['test', 'src/quality-release/source-journeys.test.ts'], {
        cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, JARVIS_DATA_DIR: scratch },
      });
      sourceProbes = { disposition: run.status === 0 ? 'passed' : 'failed', scope: 'source-stubs-only', logSha256: hash(run.stdout + run.stderr) };
      if (run.status !== 0) blockers.push('source_probes_failed');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const status = blockers.length || scorecard.status !== 'passed' ? 'blocked' : 'passed';
  const result = { ...scorecard, status, blockers: [...new Set(blockers)], sourceProbes,
    // CLI-level provenance failures must also invalidate the support matrix.
    profiles: scorecard.profiles.map(p => ({ ...p, status: blockers.length ? 'blocked' : p.status,
      supportedJobs: blockers.length ? [] : p.supportedJobs })) };
  const out = resolve(options['--out']); mkdirSync(out, { recursive: true });
  if (!options['--record']) writeFileSync(join(out, 'record.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(out, 'scorecard.json'), JSON.stringify(result, null, 2) + '\n');
  const lines = ['# Q-22 product quality scorecard', '', `Candidate: \`${candidate}\``, '', `Release: **${status}**. Deployment authorized: **false**.`, '',
    '| Profile | Deployment | Release status | Passed | Failed | Blocked | Not run | Unsupported |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |'];
  for (const p of result.profiles) lines.push(`| ${p.id} | ${p.deployment} | ${p.status} | ${p.counts.passed} | ${p.counts.failed} | ${p.counts.blocked} | ${p.counts.not_run} | ${p.counts.unsupported} |`);
  lines.push('', `Source probes: ${sourceProbes.disposition} (synthetic component checks; excluded from release counts).`, '',
    'See scorecard.json for every required journey, condition, quality check, prerequisite and separate live connector disposition.');
  writeFileSync(join(out, 'scorecard.md'), lines.join('\n') + '\n');
  console.log(JSON.stringify({ status, candidate, deploymentAuthorized: false, sourceProbes: sourceProbes.disposition }));
  return status === 'passed' ? 0 : 2;
}
if (import.meta.main) {
  try { process.exitCode = audit(process.argv.slice(2)); }
  catch { console.error('Product quality audit refused: invalid arguments, input, repository or output. No release evidence was accepted.'); process.exitCode = 1; }
}
