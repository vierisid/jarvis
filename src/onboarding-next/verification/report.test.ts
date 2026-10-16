import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { discover } from './discovery';
import { requiredCases, RELEASE_OWNERS } from './matrix';
import { artifact, evidenceDigest, gitEnvironment, ownersDigest, sourceCandidate, verifyReport } from './report';
import type { Report, Observation } from './types';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(),'b13-report-')); directories.push(root);
  const repo = resolve(root,'repo'), out = resolve(root,'evidence'); await mkdir(repo); await mkdir(out);
  // A synthetic frontend verifier module exercises the joint-gate protocol,
  // never represents U11 runtime/visual acceptance for the product.
  await mkdir(resolve(repo,'ui/src/onboarding-next/verification'),{ recursive: true });
  await writeFile(resolve(repo,'ui/src/onboarding-next/verification/report.ts'), `export const assess = r => r.assessment; export const verifyArtifacts = async r => r.errors;`);
  for (const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','commit','-m','Synthetic verifier fixture']]) {
    expect(Bun.spawnSync(['git',...args],{ cwd:repo,env:gitEnvironment() }).exitCode).toBe(0);
  }
  const candidate = await sourceCandidate(repo), discovered = await discover();
  const report: Report = { schemaVersion: 1, candidate, inventory: { present: [...discovered.present,...discovered.missing], missing: [] }, cases: [], gates: [] };
  const save = async (path: string, data: unknown) => { await writeFile(resolve(out,path),JSON.stringify(data)); return artifact(out,path); };
  const proof = await save('test-only-proof.json',{ synthetic: true });
  const profiles = [{ id:'profile-a',version:'v1' },{ id:'profile-b',version:'v2' }];
  report.staging = { profiles,
    registry: await save('registry.json',{ candidate, profiles, environment:'synthetic staging fixture',verifiedBy:'test' }),
    spendApproval: await save('spend.json',{ candidate,profiles,approved:true,approvedBy:'test',approvedAt:'2026-01-01T00:00:00Z',budgetUsd:20 }) };
  for (const spec of requiredCases()) {
    const observation: Observation = { schemaVersion:1,candidate,caseId:spec.id,kind:spec.kind,observedAt:'2026-01-02T00:00:00Z',environment:'synthetic environment',artifacts:[proof],
      details:{ testOnly:true },checks:spec.checks.map(id => ({ id,passed:true })),
      ...(spec.kind === 'real-provider' ? { profiles:profiles.map(p => ({ ...p,outcome:'passed' as const,spendUsd:1 })) } : {}) };
    report.cases.push({ id:spec.id,outcome:'passed',reason:'Synthetic acceptance fixture',evidence:[proof,await save(spec.id.replaceAll('/','--')+'.observation.json',observation)] });
  }
  report.visual = await save('visual.json',{ candidate:{ revision:candidate.frontend,tree:candidate.tree,dirty:false },assessment:{ errors:[],scope:'runtime',counts:{ passed:798 },required:798,missingGates:['ON-B-13'] },errors:[] });
  async function approve() {
    report.gates = [];
    for (const owner of RELEASE_OWNERS) report.gates.push({ owner,receipt:await save(owner+'.json',{ schemaVersion:1,owner,candidate,approved:true,approvedBy:'test',approvedAt:'2026-01-03T00:00:00Z',observations:'Synthetic test only',evidenceDigest:evidenceDigest(report),artifacts:[proof],...(owner === 'release-owner' ? { ownersDigest:ownersDigest(report) } : {}) }) });
  }
  await approve();
  const verify = () => verifyReport(report,out,candidate,repo);
  async function alterObservation(id: string, change: (data:any) => void) {
    const row = report.cases.find(r => r.id === id)!, item = row.evidence.find(e => e.path.endsWith('.observation.json'))!;
    const data = JSON.parse(await readFile(resolve(out,item.path),'utf8')); change(data); Object.assign(item,await save(item.path,data));
  }
  return { root,repo,out,report,save,verify,approve,alterObservation };
}

test('complete bound evidence and joint U11/B13 owner approval can pass', async () => {
  const f = await fixture(), verdict = await f.verify(); expect(verdict).toMatchObject({ releaseReady:true,required:43,errors:[],blockers:[] });
});
test('hook Git variables cannot redirect candidate reads or fixture repository writes',async()=>{
  const before=await sourceCandidate(), saved={ GIT_DIR:Bun.env.GIT_DIR,GIT_INDEX_FILE:Bun.env.GIT_INDEX_FILE,GIT_WORK_TREE:Bun.env.GIT_WORK_TREE };
  try { Object.assign(Bun.env,{ GIT_DIR:'/missing/git-dir',GIT_INDEX_FILE:'/missing/index',GIT_WORK_TREE:'/missing/worktree' });
    const f=await fixture(); expect((await sourceCandidate(f.repo)).backend).toBe(f.report.candidate.backend); expect((await f.verify()).releaseReady).toBe(true);
    expect(await sourceCandidate()).toEqual(before);
  } finally { for(const [key,value] of Object.entries(saved)) { if(value===undefined) delete Bun.env[key]; else Bun.env[key]=value; } }
});
test('mocked-only evidence, missing modules and missing owner approval cannot pass', async () => {
  const f = await fixture();
  f.report.cases.filter(r => r.id.startsWith('models/') || r.id.startsWith('staging/')).forEach(r => { r.outcome='blocked'; r.evidence=[]; });
  delete f.report.visual; f.report.gates=[];
  const v=await f.verify(); expect(v.releaseReady).toBe(false); expect(v.errors).toEqual([]); expect(v.blockers.length).toBeGreaterThan(10);
});
for (const kind of ['dirty','stale-backend','stale-frontend','stale-sidecar','duplicate','missing','unknown','invented-outcome','absent-module'] as const) test(`rejects ${kind}`,async () => {
  const f=await fixture();
  if(kind==='dirty') f.report.candidate.dirty=true;
  else if(kind.startsWith('stale-')) f.report.candidate[kind.slice(6) as 'backend'|'frontend'|'sidecar']='f'.repeat(40);
  else if(kind==='duplicate') f.report.cases.push(f.report.cases[0]!);
  else if(kind==='missing') f.report.cases.pop();
  else if(kind==='unknown') f.report.cases[0]!.id='not-a-case';
  else if(kind==='invented-outcome') f.report.cases[0]!.outcome='green' as never;
  else { const id=f.report.inventory.present.splice(0,1)[0]!; f.report.inventory.missing.push(id); }
  const v=await f.verify(); expect(v.releaseReady).toBe(false); expect(v.errors.length+v.blockers.length).toBeGreaterThan(0);
});
for (const kind of ['wrong-case','wrong-kind','wrong-candidate','missing-check','failed-check','duplicate-check','missing-artifact','empty-artifacts','missing-date']) test(`rejects observation ${kind}`,async () => {
  const f=await fixture(); await f.alterObservation(f.report.cases[0]!.id,d => {
    if(kind==='wrong-case') d.caseId='wrong'; if(kind==='wrong-kind') d.kind='manual'; if(kind==='wrong-candidate') d.candidate.backend='c'.repeat(40);
    if(kind==='missing-check') d.checks.pop(); if(kind==='failed-check') d.checks[0].passed=false; if(kind==='duplicate-check') d.checks.push(d.checks[0]);
    if(kind==='missing-artifact') d.artifacts[0].path='absent.json'; if(kind==='empty-artifacts') d.artifacts=[]; if(kind==='missing-date') delete d.observedAt;
  }); await f.approve(); const v=await f.verify(); expect(v.releaseReady).toBe(false); expect(v.errors.length).toBeGreaterThan(0);
});
for (const kind of ['corrupt','traversal','symlink','malformed']) test(`rejects ${kind} evidence without crashing`,async () => {
  const f=await fixture(); const item=f.report.cases[0]!.evidence[0]!;
  if(kind==='corrupt') await writeFile(resolve(f.out,item.path),'changed');
  if(kind==='traversal') item.path='../outside.json';
  if(kind==='symlink') { await symlink(resolve(f.out,item.path),resolve(f.out,'linked.json')); item.path='linked.json'; }
  if(kind==='malformed') { const observation=f.report.cases[0]!.evidence[1]!; await writeFile(resolve(f.out,observation.path),'['); Object.assign(observation,await artifact(f.out,observation.path)); }
  const v=await f.verify(); expect(v.releaseReady).toBe(false); expect(v.errors.length).toBeGreaterThan(0);
});
for (const kind of ['missing-profile','wrong-version','failed-profile','negative-spend','over-budget','approval-after-run','unapproved','no-registry']) test(`blocks model evidence: ${kind}`,async () => {
  const f=await fixture(); const id=f.report.cases.find(r=>r.id.startsWith('models/'))!.id;
  await f.alterObservation(id,d=>{ if(kind==='missing-profile') d.profiles.pop(); if(kind==='wrong-version') d.profiles[0].version='v3'; if(kind==='failed-profile') d.profiles[0].outcome='failed'; if(kind==='negative-spend') d.profiles[0].spendUsd=-1; if(kind==='over-budget') d.profiles[0].spendUsd=100; if(kind==='approval-after-run') d.observedAt='2025-01-01T00:00:00Z'; });
  if(kind==='unapproved') { const a=f.report.staging!.spendApproval; const d=JSON.parse(await readFile(resolve(f.out,a.path),'utf8')); d.approved=false; Object.assign(a,await f.save(a.path,d)); }
  if(kind==='no-registry') delete f.report.staging;
  await f.approve(); const v=await f.verify(); expect(v.releaseReady).toBe(false); expect(v.errors.length).toBeGreaterThan(0);
});
test('altering evidence after owner approval invalidates receipts',async () => {
  const f=await fixture(); f.report.cases[0]!.reason='Changed after approval'; expect((await f.verify()).errors.some(e=>e.includes('stale gate'))).toBe(true);
});
test('release owner must approve the exact D/F/Q decisions',async () => {
  const f=await fixture(), gate=f.report.gates.find(g=>g.owner==='D')!;
  const receipt=JSON.parse(await readFile(resolve(f.out,gate.receipt.path),'utf8')); receipt.observations='Changed D decision'; gate.receipt=await f.save(gate.receipt.path,receipt);
  expect((await f.verify()).errors).toContain('Release owner did not approve these owner decisions.');
});
test('owner approvals must follow the observations they approve',async()=>{
  const f=await fixture(); const gate=f.report.gates.find(g=>g.owner==='D')!;
  const d=JSON.parse(await readFile(resolve(f.out,gate.receipt.path),'utf8')); d.approvedAt='2025-01-01T00:00:00Z'; gate.receipt=await f.save(gate.receipt.path,d);
  expect((await f.verify()).errors).toContain('Owner approval predates observations: D');
});
for(const kind of ['fixture','incomplete','missing-D','stale-B13','bad-artifact','dirty-source']) test(`U11 ${kind} cannot certify the joint gate`,async()=>{
  const f=await fixture(), a=f.report.visual!, d=JSON.parse(await readFile(resolve(f.out,a.path),'utf8'));
  if(kind==='fixture') d.assessment.scope='fixture'; if(kind==='incomplete') d.assessment.counts.passed--; if(kind==='missing-D') d.assessment.missingGates.push('D');
  if(kind==='stale-B13') d.assessment.errors.push('Gate not verified: ON-B-13'); if(kind==='bad-artifact') d.errors.push('Missing screenshot');
  if(kind==='dirty-source') await writeFile(resolve(f.repo,'unexpected.txt'),'dirty');
  f.report.visual=await f.save(a.path,d); await f.approve(); const v=await f.verify(); expect(v.releaseReady).toBe(false); expect(v.errors.length+v.blockers.length).toBeGreaterThan(0);
});
