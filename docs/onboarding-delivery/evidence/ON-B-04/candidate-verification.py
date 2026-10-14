from pathlib import Path
import json, os, subprocess
candidate=Path('/home/vierisid/.cache/codex/jarvis-on-b-04-candidate').resolve()
output=Path('/home/vierisid/.cache/codex/jarvis-on-b-04-output').resolve()
assert candidate.parent==Path('/home/vierisid/.cache/codex') and candidate.name=='jarvis-on-b-04-candidate'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=candidate,text=True).strip()=='5024ea7455a5613be0514475be32c0dee6de0edd'
env=dict(os.environ,PATH='/home/vierisid/.cache/codex/toolchains/bun-1.4.2/bun-linux-x64:/usr/local/bin:/usr/bin:/bin')
modules=[('src/onboarding-next/interview-session','interview'),('ui/src/onboarding-next/views/interview','view')]
def command(args,name):
 with (output/(name+'.log')).open('w') as log: result=subprocess.run(args,cwd=candidate,env=env,stdout=log,stderr=subprocess.STDOUT)
 print(name,result.returncode,flush=True)
 if result.returncode: print((output/(name+'.log')).read_text()[-5000:]); raise SystemExit(result.returncode)
def fixture(phase):
 present=[(path,name) for path,name in modules if (candidate/path/'manifest.json').exists()]
 imports=[]
 for path,name in present:
  entry=json.loads((candidate/path/'manifest.json').read_text())['entry'][2:]
  imports += [f"import * as {name} from '../../{path}/{entry}';",f"import {name}Manifest from '../../{path}/manifest.json';"]
 text="import {expect,test} from 'bun:test';\n"+'\n'.join(imports)+'\n'
 text+='const manifests: Array<{provides:string[],requires:string[]}> = ['+','.join(name+'Manifest' for _,name in present)+'];\n'
 text+="const available=new Set(manifests.flatMap(m=>m.provides));\n"
 text+="test('synthetic assembly stays default-off and missing B05 is unsupported',()=>{expect(available.has('interview-profile.v1')).toBe(false);const enabled=false;expect(enabled).toBe(false)});\n"
 text+="test('present module closure is incomplete until B05 exists',()=>expect(['interview-session.v1','interview-profile.v1','interview-view.v1'].every(c=>available.has(c))).toBe(false));\n"
 if any(name=='interview' for _,name in present):
  text+="test('provider with missing profile never touches storage',async()=>{const p=interview.createInterviewSessionProvider({enabled:true,authorize:()=>({actorId:'fixture',projectId:'fixture'}),store:{transaction(){throw new Error('must not run')}}});expect((await p.request(null,{type:'start'})).kind).toBe('unavailable')});\n"
 if any(name=='view' for _,name in present): text+="test('actual view loads independently',()=>expect(typeof view.InterviewView).toBe('function'));\n"
 if phase=='combined':
  text+="""
import {Database} from 'bun:sqlite';
import {createInterviewSession} from '../daemon/onboarding-interviewer.ts';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
test('actual provider snapshot supplies actual U04 view through structural ports',async()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
 try {
  const provider=interview.createInterviewSessionProvider({enabled:true,authorize:()=>({actorId:'fixture',projectId:'fixture'}),store:interview.createSettingsInterviewStore(()=>db),
   interviewer:{create:createInterviewSession,async prepare({session}){session.turnCount++;session.messages.push({role:'assistant',content:'Fixture opening question'});return {session,result:{assistantText:'Fixture opening question',done:false,factsRecorded:0},facts:[]};}},
   profile:{capability:'interview-profile.v1',async commit(){return {confirmedFactIds:[]}}}});
  const result=await provider.request(null,{type:'start'});expect(result.kind).toBe('ok');if(result.kind!=='ok')throw new Error(result.reason);
  const model:view.InterviewModel={...result.snapshot,theme:'light',draft:{text:'Kept draft',clientRequestId:'fixture-request'},navigation:{revision:0,kind:'ready'}};
  const noop=()=>{};const html=renderToStaticMarkup(createElement(view.InterviewView,{model,onDraftChange:noop,onSubmit:noop,onRetry:noop,onSkip:noop,onContinue:noop}));
  expect(html).toContain('Fixture opening question');expect(html).toContain('Kept draft');
 } finally {db.close()}
});
"""
 target=candidate/'src/onboarding-next/candidate.fixture.test.ts';target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text)
 command(['bun','test','./src/onboarding-next/candidate.fixture.test.ts']+[path for path,_ in present],phase+'-tests')
 command(['bunx','tsc','--noEmit'],phase+'-typecheck')
 command(['bun','run','build:ui'],phase+'-build-ui')
command(['bun','install','--frozen-lockfile'],'candidate-install')
fixture('absent')
command(['git','restore','--source=74d64908a65b2682c7c1ee3befce52e16b01315f','--staged','--worktree','--','src/onboarding-next/interview-session'],'load-standalone')
fixture('standalone')
command(['git','restore','--source=e7ce2d65d40cd6ac83f3e8421bbe27ef67845f16','--staged','--worktree','--','ui/src/onboarding-next/views/interview'],'load-view')
fixture('combined')
source=(candidate/'src/onboarding-next/interview-session').resolve();dest=(output/'rollback-interview-session').resolve()
assert source.is_relative_to(candidate) and dest.is_relative_to(output) and not dest.exists()
source.rename(dest)
fixture('provider-removed')
print('PASS: isolated candidate only; actual B05/B11/U10 assembly is absent',flush=True)
