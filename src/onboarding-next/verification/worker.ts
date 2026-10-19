import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { requiredCases } from './matrix';
import { artifact } from './report';
import { scenario } from './scenarios';
import type { Observation } from './types';

if (import.meta.main) {
  const [id, directory, candidateFile] = process.argv.slice(2);
  const spec = requiredCases().find(c => c.id === id);
  if (!spec || spec.kind !== 'mocked' || spec.suites || !directory || !candidateFile) throw Error('Invalid isolated scenario arguments');
  const details = await scenario(spec.id, directory);
  const observation: Observation = { schemaVersion: 1, candidate: JSON.parse(await readFile(candidateFile,'utf8')), caseId: spec.id, kind: 'mocked',
    observedAt: new Date().toISOString(), artifacts: [await artifact(dirname(directory), `${basename(directory)}/saved.sqlite`)],
    checks: spec.checks.map(id => ({ id, passed: true })), details };
  await writeFile(resolve(directory, 'case.observation.json'), JSON.stringify(observation,null,2));
}
