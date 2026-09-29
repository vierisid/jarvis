import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fingerprint } from '../../actions/tools/composition-provenance';
import type { EvaluationRow } from './types';

const root = resolve(import.meta.dir, '../../..');

test('CLI review accepts the exact redacted hosted error row and still rejects changed results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-review-redaction-'));
  const key = 'synthetic-review-key-never-a-real-credential';
  const profile = join(directory, 'profile.json');
  const preload = join(directory, 'provider-fixture.ts');
  const output = join(directory, 'run');
  // Exercise the actual CLI/provider path without making any network requests.
  writeFileSync(preload, `globalThis.fetch = async () => { throw new Error(${JSON.stringify('Network fixture failed: ' + key)}); };\n`);
  writeFileSync(profile, JSON.stringify({
    id: 'review-regression', version: '1', intendedModel: 'terra-fixture',
    baseUrl: 'https://example.invalid', apiKeyEnv: 'W8_REVIEW_TEST_KEY', routingEvidence: 'Synthetic test only',
  }));

  async function cli(args: string[], withProvider = false) {
    const child = Bun.spawn([process.execPath, ...(withProvider ? ['--preload', preload] : []),
      join(root, 'scripts/evaluate-workflow-quality.ts'), ...args], {
      cwd: root, env: { ...process.env, W8_REVIEW_TEST_KEY: key }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  try {
    const generated = await cli(['--mode', 'hosted', '--profile', profile,
      '--max-requests', '1', '--out', output], true);
    expect(generated.code).toBe(1); // One failed fixture request, with remaining tasks unrun.
    const raw = readFileSync(join(output, 'rows.jsonl'), 'utf8');
    const rows = raw.trim().split('\n').map(line => JSON.parse(line) as EvaluationRow);
    const template = JSON.parse(readFileSync(join(output, 'review-template.json'), 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.calls[0]!.error).toContain('[REDACTED]');
    expect(raw).not.toContain(key);
    expect(readFileSync(join(output, 'events.jsonl'), 'utf8')).not.toContain(key);
    expect(template[0].rowSha256).toBe(fingerprint(rows[0]));
    expect(rows[0]!.humanIntentCorrect).toBeNull();

    const reviews = join(directory, 'reviews.json');
    writeFileSync(reviews, JSON.stringify([{ ...template[0], reviewer: 'Fixture reviewer',
      intentCorrect: false, elapsedMs: 1200, edits: 0, notes: 'Provider failed before generation.' }]));
    const reviewedOutput = join(directory, 'reviewed');
    const reviewed = await cli(['--mode', 'review', '--results', join(output, 'rows.jsonl'),
      '--reviews', reviews, '--out', reviewedOutput]);
    expect(reviewed.code).toBe(0);
    const reviewedRows = JSON.parse(readFileSync(join(reviewedOutput, 'reviewed-rows.json'), 'utf8'));
    expect(reviewedRows[0].humanIntentCorrect).toBe(false);
    expect(reviewedRows[0].supervision.reviewer).toBe('Fixture reviewer');
    expect(readFileSync(join(output, 'rows.jsonl'), 'utf8')).toBe(raw);

    const tampered = join(directory, 'changed-rows.jsonl');
    rows[0]!.calls[0]!.error = 'Different result';
    writeFileSync(tampered, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const rejected = await cli(['--mode', 'review', '--results', tampered,
      '--reviews', reviews, '--out', join(directory, 'rejected')]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('Review has unknown, duplicated or changed result');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
