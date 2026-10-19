import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from './manifest.json';
import { createCanonicalInterviewProfileStore, createInterviewProfileProvider, createStagedInterviewer } from './index.ts';

test('factories are inert and the optional provider has no sibling imports', () => {
  const unused = () => { throw Error('factory accessed a service'); };
  const store = createCanonicalInterviewProfileStore({ owner: { actorId: 'a', projectId: 'p' }, database: unused });
  createInterviewProfileProvider({ store }); createStagedInterviewer({ llmForScope: unused });
  expect(manifest.provides).toEqual(['interview-profile.v1']); expect(manifest.requires).toEqual([]);
  for (const file of readdirSync(import.meta.dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/(journey|setup|google|interview-session|runtime|diagnostics)\//);
    expect(source).not.toMatch(/console\.(log|warn|error)|initDatabase\(|createGoal\(|createWorkflow\(/);
  }
});
