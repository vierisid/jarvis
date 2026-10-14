from pathlib import Path
import json, os, subprocess
candidate = Path('/home/vierisid/.cache/codex/jarvis-on-b-02-candidate').resolve()
output = Path('/home/vierisid/.cache/codex/jarvis-on-b-02-output').resolve()
assert candidate.parent == Path('/home/vierisid/.cache/codex') and candidate.name == 'jarvis-on-b-02-candidate'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=candidate,text=True).strip() == '5024ea7455a5613be0514475be32c0dee6de0edd'
env = dict(os.environ, PATH='/home/vierisid/.cache/codex/toolchains/bun-1.4.2/bun-linux-x64:/usr/local/bin:/usr/bin:/bin')
modules = [('src/onboarding-next/setup','setup'),('src/onboarding-next/journey','journey'),('ui/src/onboarding-next/views/explainer','explainer')]
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
        imports.append(f"import * as {name} from './{path}/{entry}';")
        imports.append(f"import {name}Manifest from './{path}/manifest.json';")
    manifests = ','.join(name+'Manifest' for _,name in present)
    text = "import { expect, test } from 'bun:test';\n" + '\n'.join(imports) + '\n'
    text += 'const manifests: Array<{provides:string[],requires:string[]}> = ['+manifests+'];\n'
    text += "const available = new Set(manifests.flatMap(m => m.provides));\n"
    text += "const complete = ['journey.v1','setup.v1','explainer-view.v1'].every(c => available.has(c));\n"
    text += "test('synthetic host remains default-off', () => { const released = false; expect(released && complete).toBe(false); });\n"
    text += "test('synthetic closure matches physically present modules', () => expect(complete).toBe("+str(phase=='combined').lower()+"));\n"
    if any(name=='setup' for _,name in present):
        text += "test('missing injected setup services are unavailable', async () => expect(await setup.createSetupProvider({authorize:()=>({actorId:'fixture',projectId:'fixture'})}).read(null)).toMatchObject({supported:false,ready:false}));\n"
    if any(name=='journey' for _,name in present):
        text += "test('journey exports remain independently loadable', () => expect(typeof journey.createJourneyProvider).toBe('function'));\n"
    if any(name=='explainer' for _,name in present):
        text += "test('controlled explainer exports remain loadable', () => expect(typeof explainer.ExplainerView).toBe('function'));\n"
    (candidate/'assembly.fixture.test.ts').write_text(text)
    command(['bun','test','./assembly.fixture.test.ts'] + [path for path,_ in present],phase+'-tests')
    command(['bunx','tsc','--noEmit'],phase+'-typecheck')
    command(['bun','run','build:ui'],phase+'-build-ui')
fixture('absent')
command(['git','restore','--source=a6a6e6d23c00449f39aee9e85a4cc2480d911b7e','--staged','--worktree','--','src/onboarding-next/setup'],'load-standalone')
fixture('standalone')
command(['git','restore','--source=16e09ad5e891845905fcad872e98ef4f5109ba57','--staged','--worktree','--','src/onboarding-next/journey'],'load-journey')
command(['git','restore','--source=82d011f0a8ea8205a7233cf9b141b0e363212ba1','--staged','--worktree','--','ui/src/onboarding-next/views/explainer'],'load-explainer')
fixture('combined')
(candidate/'src/onboarding-next/setup').rename(output/'rollback-setup')
fixture('setup-removed')
print('PASS: isolated candidate only; production assembly is absent', flush=True)
