import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assess, verifyArtifacts } from './report';
const [file, revision] = process.argv.slice(2);
try {
  if (!file || !revision) throw Error('Usage: bun ui/src/onboarding-next/verification/verify.ts report.json FULL_CANDIDATE_SHA');
  const report = JSON.parse(await readFile(file, 'utf8'));
  const result = assess(report, revision);
  result.errors.push(...await verifyArtifacts(report, dirname(resolve(file))));
  result.releaseReady &&= !result.errors.length;
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.releaseReady ? 0 : 1;
} catch (error) { console.error(String(error)); process.exitCode = 2; }
