import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from './discovery';
import { sourceCandidate, verifyReport } from './report';
import { run } from './runner';

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2), options = new Map<string,string>();
    const allowed = command === 'run' ? ['--out','--case','--frontend','--sidecar'] : ['--out','--frontend','--sidecar','--frontend-root'];
    if (!['run','verify'].includes(command ?? '') || args.length % 2) throw Error('Use run|verify --out DIRECTORY [--frontend SHA --sidecar SHA]; run accepts --case ID; verify accepts --frontend-root PATH.');
    for (let i=0;i<args.length;i+=2) { const key=args[i]!, value=args[i+1]!; if (!allowed.includes(key) || options.has(key) || !value) throw Error('Invalid/duplicate option'); options.set(key,value); }
    if (!options.has('--out')) throw Error('--out required');
    const directory = resolve(options.get('--out')!);
    const verdict = command === 'run' ? (await run(directory, { only: options.get('--case'), frontend: options.get('--frontend'), sidecar: options.get('--sidecar') })).verdict
      : await verifyReport(JSON.parse(await readFile(resolve(directory,'report.json'),'utf8')), directory,
        await sourceCandidate(ROOT, options.get('--frontend'), options.get('--sidecar')), options.get('--frontend-root') ?? ROOT);
    console.log(JSON.stringify(verdict,null,2));
    process.exitCode = verdict.errors.length ? 2 : verdict.releaseReady ? 0 : 1;
  } catch (error) { console.error(String(error)); process.exitCode = 2; }
}
