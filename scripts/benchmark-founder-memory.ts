import { readFileSync } from 'node:fs';
import { compareFounderReports, IMPLEMENTATION_ROOT, runFounderRecallBenchmark, type FounderReport } from '../src/vault/evaluation/founder-recall.ts';

const args = process.argv.slice(2);
if (args[0] === 'compare' && args[1] && args[2]) {
  const result = compareFounderReports(JSON.parse(readFileSync(args[1], 'utf8')) as FounderReport,
    JSON.parse(readFileSync(args[2], 'utf8')) as FounderReport);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
} else if (args[0] === 'development' || args[0] === 'heldout') {
  const at = args.indexOf('--implementation-root');
  if (at >= 0 && !args[at + 1]) throw new Error('--implementation-root requires a checkout path');
  const result = await runFounderRecallBenchmark(args[0], at < 0 ? IMPLEMENTATION_ROOT : args[at + 1]!);
  console.log(JSON.stringify(result, null, 2));
  if (args.includes('--check') && (result.summary.casePass.rate !== 1 || result.summary.stableCases.rate !== 1)) process.exitCode = 1;
} else throw new Error('Usage: bun scripts/benchmark-founder-memory.ts development|heldout [--implementation-root path] [--check], or compare baseline.json candidate.json');
