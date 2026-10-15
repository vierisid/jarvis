import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { audit } from './check-product-quality';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'q22-cli-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('default audit emits every unrun case and blocked support profiles', () => {
  expect(audit(['--out', dir])).toBe(2);
  const report = JSON.parse(readFileSync(join(dir, 'scorecard.json'), 'utf8'));
  expect(report.status).toBe('blocked'); expect(report.deploymentAuthorized).toBe(false);
  expect(report.prerequisites).toHaveLength(27); expect(report.blockers).toContain('rubric_not_frozen');
  expect(report.profiles.map((p: any) => p.counts.not_run)).toEqual([29, 29]);
  expect(report.profiles.every((p: any) => p.supportedJobs.length === 0)).toBe(true);
  expect(report.sourceProbes.disposition).toBe('not_run');
  expect(readFileSync(join(dir, 'scorecard.md'), 'utf8')).toContain('| hosted-unresolved | hosted | blocked |');
});
test('invalid private input is refused without printing its bytes', () => {
  const input = join(dir, 'private.json'); writeFileSync(input, 'PRIVATE_CREDENTIAL');
  const child = spawnSync(process.execPath, ['scripts/check-product-quality.ts', '--record', input, '--out', dir], { encoding: 'utf8' });
  expect(child.status).toBe(1); expect(child.stdout + child.stderr).not.toContain('PRIVATE_CREDENTIAL');
});
test('unknown and duplicate CLI options cannot silently change audit scope', () => {
  expect(() => audit(['--out', dir, '--out', dir])).toThrow('invalid_arguments');
  expect(() => audit(['--deploy', 'true'])).toThrow('invalid_arguments');
  expect(() => audit([])).toThrow('output_required');
});
