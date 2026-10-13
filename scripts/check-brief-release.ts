/** Read-only release audit. Input is saved operator evidence, not credentials or an activation command. */
import { assessRelease, type Deployment } from '../src/brief/release/activation';

const [recordPath, snapshotPath, revision, deployment, hostingRevision] = process.argv.slice(2);
if (!recordPath || !snapshotPath || !/^[0-9a-f]{40}$/.test(revision ?? '') || !['hosted', 'self_hosted'].includes(deployment ?? '')
  || (hostingRevision !== undefined && !/^[0-9a-f]{40}$/.test(hostingRevision))) {
  console.error('Usage: bun scripts/check-brief-release.ts <release-record.json> <capabilities.json> <runtime-commit> <hosted|self_hosted> [hosting-commit]');
  process.exit(2);
}
try {
  const report = assessRelease(await Bun.file(recordPath).json(), await Bun.file(snapshotPath).json(), {
    revision: revision!, deployment: deployment as Deployment, hostingRevision,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'ready' ? 0 : 1;
} catch {
  console.error('Release evidence could not be read. No feature is authorized.');
  process.exitCode = 2;
}
