import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ROOT, containedFile, discover } from './discovery';
import { isNoDraftRecovery } from './recovery';
import { requiredCases } from './matrix';
import { readArtifact, sourceCandidate } from './report';
import { child } from './runner';

const inventory = await discover();
for (const spec of requiredCases().filter(c => !c.suites && c.kind === 'mocked' && c.requires.every(id => inventory.present.includes(id)))) {
  test(`isolated provider scenario: ${spec.id}`, async () => {
    const root=await mkdtemp(resolve(tmpdir(),'b13-scenario-'));
    try {
      const candidate=await sourceCandidate(); await writeFile(resolve(root,'candidate.json'),JSON.stringify(candidate));
      const output=await child([process.execPath,resolve(import.meta.dir,'worker.ts'),spec.id,root,resolve(root,'candidate.json')],ROOT,20000);
      expect(output.code,output.output).toBe(0); expect(output.timedOut).toBe(false);
      const observation=JSON.parse(await readFile(resolve(root,'case.observation.json'),'utf8'));
      expect(observation.caseId).toBe(spec.id); expect(observation.candidate).toEqual(candidate); expect(observation.details.externalEffects).toBe(0);
      // Verify after process exit, including the final SQLite WAL checkpoint.
      for (const a of observation.artifacts) await readArtifact(tmpdir(),a);
      const db=new Database(resolve(root,'saved.sqlite'),{ readonly:true });
      try { expect(db.query('SELECT count(*) AS n FROM flow_run').get()).toEqual({ n:0 });
        expect(db.query("SELECT count(*) AS n FROM flow WHERE status!='DISABLED' OR published_version_id IS NOT NULL").get()).toEqual({ n:0 });
        expect((db.query('SELECT count(*) AS n FROM flow').get() as {n:number}).n).toBeLessThanOrEqual(1);
      } finally { db.close(); }
    } finally { await rm(root,{ recursive:true,force:true }); }
  },30000);
  const mode=spec.id.split('/').at(-1)!;
  if (isNoDraftRecovery(mode)) test(`worker refuses false recovery evidence: ${spec.id}`,async()=>{
    const root=await mkdtemp(resolve(tmpdir(),'b13-false-recovery-'));
    try {
      await writeFile(resolve(root,'candidate.json'),JSON.stringify(await sourceCandidate()));
      const provider=await containedFile(ROOT,'src/onboarding-next/build-jobs/index.ts');
      // Mutate only the terminal read boundary in this child process. Real
      // composition, persistence, reconciliation and result recovery still run.
      await writeFile(resolve(root,'wrong-outcome.ts'),`
        import { mock } from 'bun:test';
        const api = { ...await import(${JSON.stringify(provider)}) };
        mock.module(${JSON.stringify(provider)}, () => ({ ...api, createBuildJobsProvider: deps => {
          const build = api.createBuildJobsProvider(deps), read = build.read;
          return { ...build, read: async (...args) => {
            const result = await read(...args);
            if (result.status?.resolution === 'none') result.status.outcome = ${JSON.stringify(mode==='cancel-before-save'?'failed':'needs_input')};
            return result;
          } };
        } }));
      `);
      const output=await child([process.execPath,'--preload',resolve(root,'wrong-outcome.ts'),resolve(import.meta.dir,'worker.ts'),spec.id,root,resolve(root,'candidate.json')],ROOT,20000);
      expect(output.timedOut).toBe(false); expect(output.code).not.toBe(0);
      expect(output.output).toContain(`${mode}: job outcome`);
      expect(await Bun.file(resolve(root,'case.observation.json')).exists()).toBe(false);
    } finally { await rm(root,{recursive:true,force:true}); }
  },30000);
}
