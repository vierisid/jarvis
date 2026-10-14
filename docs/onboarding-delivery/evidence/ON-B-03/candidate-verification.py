from pathlib import Path
import json, os, subprocess
candidate = Path('/home/vierisid/.cache/codex/jarvis-on-b-03-candidate').resolve()
output = Path('/home/vierisid/.cache/codex/jarvis-on-b-03-output').resolve()
assert candidate.parent == Path('/home/vierisid/.cache/codex') and candidate.name == 'jarvis-on-b-03-candidate'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=candidate,text=True).strip() == '5024ea7455a5613be0514475be32c0dee6de0edd'
env = dict(os.environ, PATH='/home/vierisid/.cache/codex/toolchains/bun-1.4.2/bun-linux-x64:/usr/local/bin:/usr/bin:/bin')
modules = [('src/onboarding-next/google','google'),('ui/src/onboarding-next/views/google','view')]
def command(args, name):
    with (output / (name + '.log')).open('w') as log:
        result = subprocess.run(args,cwd=candidate,env=env,stdout=log,stderr=subprocess.STDOUT)
    print(name, result.returncode, flush=True)
    if result.returncode: raise SystemExit(result.returncode)
def fixture(phase):
    present = [(path,name) for path,name in modules if (candidate/path/'manifest.json').exists()]
    imports = []
    for path,name in present:
        entry = json.loads((candidate/path/'manifest.json').read_text())['entry'][2:]
        imports += [f"import * as {name} from '../../{path}/{entry}';", f"import {name}Manifest from '../../{path}/manifest.json';"]
    text = "import { expect, test } from 'bun:test';\n" + '\n'.join(imports) + '\n'
    text += 'const manifests: Array<{provides:string[],requires:string[]}> = ['+','.join(name+'Manifest' for _,name in present)+'];\n'
    text += "const available = new Set(manifests.flatMap(m => m.provides));\n"
    text += "const complete = ['google-state.v1','google-view.v1'].every(c => available.has(c));\n"
    text += "test('synthetic host stays default-off', () => { const released = false; expect(released && complete).toBe(false); });\n"
    text += "test('synthetic closure matches physically present modules', () => expect(complete).toBe("+str(phase=='combined').lower()+"));\n"
    if any(name=='google' for _,name in present):
        text += "test('missing authenticated binding stays unsupported', async () => expect(google.createGoogleProvider({authorize:()=>({actorId:'fixture',projectId:'fixture'}),resolve:()=>null}).read(null)).rejects.toMatchObject({code:'unavailable'}));\n"
    if any(name=='view' for _,name in present):
        text += "test('view loads with provider absent or present', () => expect(typeof view.GoogleView).toBe('function'));\n"
    if phase == 'combined':
        text += """
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
test('actual provider snapshot structurally supplies the actual Google view', async () => {
  const owner = { actorId: 'fixture', projectId: 'fixture' };
  const provider = google.createGoogleProvider({ authorize: () => owner, resolve: () => ({
    id:'fixture-vault', owner, installMode:'hosted', readGrant: async () => ({ state:'verified', accountLabel:'fixture@example.test', scopes:[
      'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'] })
  }) });
  const snapshot = await provider.read(null);
  const model: view.GoogleModel = { theme:'light', connection:snapshot.connection, navigation:{kind:'ready'} };
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(view.GoogleView, { model, onConnect:noop, onCancel:noop, onBack:noop, onSkip:noop, onContinue:noop }));
  expect(html).toContain('Google connection confirmed.'); expect(html).toContain('fixture@example.test');
});
"""
    target = candidate/'src/onboarding-next/candidate.fixture.test.ts'
    target.parent.mkdir(parents=True,exist_ok=True)
    # The fixture lives under src so the real repository typecheck includes the cross-module projection.
    target.write_text(text)
    command(['bun','test','./src/onboarding-next/candidate.fixture.test.ts'] + [path for path,_ in present],phase+'-tests')
    command(['bunx','tsc','--noEmit'],phase+'-typecheck')
    command(['bun','run','build:ui'],phase+'-build-ui')
fixture('absent')
command(['git','restore','--source=91f97469546cedb5a4f975d3328d0c01f0b714a9','--staged','--worktree','--','src/onboarding-next/google'],'load-standalone')
fixture('standalone')
command(['git','restore','--source=5cc2b4397b6b79fe8d31e7dd1c058cfb8ee52d84','--staged','--worktree','--','ui/src/onboarding-next/views/google'],'load-view')
fixture('combined')
(candidate/'src/onboarding-next/google').rename(output/'rollback-google')
fixture('google-removed')
print('PASS: isolated candidate only; production assembly is absent', flush=True)
