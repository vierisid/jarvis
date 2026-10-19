import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sourceRecord from '../src/brief/release/fixtures/release-record.json';
import { BriefCapabilities } from '../src/brief/capabilities';

test('release audit CLI distinguishes blocked, technically ready and unreadable evidence without mutating inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f28-audit-'));
  try {
    const recordPath = join(directory, 'record.json'), snapshotPath = join(directory, 'snapshot.json');
    const snapshot = new BriefCapabilities([{ id: 'conversations', provider: { readiness: () => 'ready' } }], ['conversations']).snapshot();
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, 'check-brief-release.ts'), ...args]);
    writeFileSync(recordPath, JSON.stringify(sourceRecord));
    const blocked = run(recordPath, snapshotPath, sourceRecord.revision, 'self_hosted');
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout.toString()).capabilities.conversations.enabled).toBe(false);
    // Synthetic test-only merged evidence never leaves this temporary directory.
    const ready = { ...sourceRecord, approvedCapabilities: ['conversations'],
      prs: sourceRecord.prs.map(pr => ({ ...pr, state: 'MERGED', mergeCommit: pr.head })),
      checks: Object.fromEntries(Object.entries(sourceRecord.checks).map(([key, value]) => [key, { ...value, status: 'passed' }])) };
    writeFileSync(recordPath, JSON.stringify(ready));
    const eligible = run(recordPath, snapshotPath, sourceRecord.revision, 'self_hosted');
    expect(eligible.exitCode).toBe(0);
    expect(JSON.parse(eligible.stdout.toString()).deploymentAuthorized).toBe(false);
    expect(run(recordPath, snapshotPath, 'invalid', 'self_hosted').exitCode).toBe(2);
    expect(run(join(directory, 'missing'), snapshotPath, sourceRecord.revision, 'self_hosted').exitCode).toBe(2);
    expect(Bun.file(recordPath).size).toBe(Buffer.byteLength(JSON.stringify(ready)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
