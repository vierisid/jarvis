import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import manifest from './manifest.json';
import { savedResult } from './model';
import { modelFor } from './preview/fixtures';
const b10 = '../../../../../src/onboarding-next/result/index.ts';
const b10Fixture = '../../../../../src/onboarding-next/result/fixtures.test.ts';
const database = '../../../../../src/workflows/db/index.ts';
const hostContract = '../../host/contract.ts';
const present = (p: string) => existsSync(join(import.meta.dir, p));
test('optional view has a frozen manifest and no sibling/runtime imports', () => {
  expect(manifest).toEqual({ schemaVersion: 1, id: 'ON-U-09', kind: 'view', entry: './index.tsx', provides: ['result-view.v1'], requires: ['draft-result.v1'] });
  for (const file of readdirSync(import.meta.dir).filter(p => /\.tsx?$/.test(p) && !p.includes('.test.'))) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8');
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]);
    expect(imports.every(p => p === 'react' || p?.startsWith('./'))).toBe(true);
    expect(source).not.toMatch(/\b(fetch|WebSocket|setInterval)\s*\(/);
  }
});
test.skipIf(!present(hostContract))('actual U10 discovery contract accepts ResultView manifest', async () => {
  const host = await import(hostContract);
  expect(host.validManifest(manifest, host.VIEWS.find((v: any) => v.directory === 'result'))).toBe(true);
});
test.skipIf(!present(b10))('actual B10 saved graph, exact version recovery, missing inputs and deletion project safely', async () => {
  const { createDraftResultProvider } = await import(b10);
  const { fixture, input } = await import(b10Fixture);
  const { closeWorkflowDb } = await import(database);
  const f = fixture();
  try {
    const provider = createDraftResultProvider({ enabled: true, authorize: () => f.owner, servicesFor: () => f.services });
    const first = await provider.read(null, input);
    expect(first.state).toBe('saved'); const model = modelFor(first); const projected = savedResult(model)!;
    expect(projected.graph).toEqual(first.graph); expect(projected.continuation).toEqual(first.continuation);
    expect(projected.workflow.selection).toEqual({ flowId: f.flow.id, versionId: f.version.id });
    const reopened = await provider.read(null, { ...first.recovery.input, selectedNodeId: 'draft' });
    expect(savedResult({ ...model, revision: 2, result: reopened })?.selectedNodeId).toBe('draft');
    f.db.run('DELETE FROM flow_version WHERE id = ?', [f.version.id]);
    const deleted = await provider.read(null, first.recovery.input);
    expect(savedResult({ ...model, revision: 3, result: deleted })).toBeNull();
    expect(f.db.query('SELECT * FROM flow_run').all()).toHaveLength(0);
  } finally { closeWorkflowDb(); }
});
