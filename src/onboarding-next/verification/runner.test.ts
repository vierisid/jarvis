import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { containedFile, discover } from './discovery';
import { PROVIDERS, requiredCases } from './matrix';
import { child, run, suiteVerdict } from './runner';

test('empty/partial discovery retains the complete required denominator and rejects substituted manifests', async () => {
  const root=await mkdtemp(resolve(tmpdir(),'b13-discovery-'));
  try {
    const empty=await discover(root); expect(empty.present).toEqual([]); expect(empty.missing.length).toBe(23); expect(requiredCases()).toHaveLength(43);
    const [id,folder,cap,requires]=PROVIDERS[0]; await mkdir(resolve(root,'src/onboarding-next',folder),{ recursive:true });
    const path=resolve(root,'src/onboarding-next',folder,'manifest.json');
    await writeFile(path,JSON.stringify({ schemaVersion:1,id,kind:'provider',entry:'./index.ts',provides:[cap],requires })); await writeFile(resolve(root,'src/onboarding-next',folder,'index.ts'),'export {};');
    expect((await discover(root)).present).toEqual([id]); expect(requiredCases()).toHaveLength(43);
    await writeFile(path,JSON.stringify({ schemaVersion:1,id,kind:'provider',entry:'../execute.ts',provides:[cap],requires })); await expect(discover(root)).rejects.toThrow('Invalid manifest');
  } finally { await rm(root,{ recursive:true,force:true }); }
});
test('source and evidence paths reject traversal and symlinked files',async()=>{
  const root=await mkdtemp(resolve(tmpdir(),'b13-path-'));
  try { await writeFile(resolve(root,'file'),'value'); await symlink(resolve(root,'file'),resolve(root,'alias'));
    for(const path of ['../file','/file','./file','alias']) await expect(containedFile(root,path)).rejects.toThrow();
  } finally { await rm(root,{ recursive:true,force:true }); }
});
test('owner-suite exit zero does not promote skipped or empty suites',()=>{
  const result=(output:string,code=0)=>suiteVerdict({ code,timedOut:false,output }).outcome;
  expect(result('3 pass\n0 fail\n')).toBe('passed'); expect(result('3 pass\n1 skip\n0 fail\n')).toBe('blocked'); expect(result('0 pass\n0 fail\n')).toBe('blocked'); expect(result('3 pass\n0 fail\n',1)).toBe('failed');
  expect(suiteVerdict({ code:0,timedOut:true,output:'3 pass\n0 fail\n' }).outcome).toBe('failed');
});
test('isolated subprocess timeout is bounded',async()=>{ const r=await child([process.execPath,'-e','setInterval(() => {}, 1000)'],process.cwd(),50); expect(r.timedOut).toBe(true); expect(r.code).not.toBe(0); });
test('a directory name beginning with two dots is still inside the checkout',async()=>{
  const root=await mkdtemp(resolve(tmpdir(),'b13-output-'));
  try { for(const path of ['..evidence','nested/output','.']) await expect(run(resolve(root,path),{root})).rejects.toThrow('outside the source checkout'); }
  finally { await rm(root,{recursive:true,force:true}); }
});
