/** Real daemon and sidecar acceptance. No fixtures or model substitutions. */
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('bun run dev [--data-dir PATH] [--port 3143] [--enroll DEVICE_NAME]\nDefaults to ~/.jarvis-local-acceptance. Reuse its directory to resume; choose a new one for a fresh onboarding.');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  if (!['--data-dir', '--port', '--enroll'].includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw Error('Invalid arguments. Run bun run dev --help');
  if (args.indexOf(args[i]!) !== i) throw Error('Duplicate option: ' + args[i]);
}
function option(name: string, fallback: string) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]!; }
const requestedRoot = resolve(option('--data-dir', join(homedir(), '.jarvis-local-acceptance')));
mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
// The engine validates physical build inputs. Use the same canonical root when
// a developer's persistent data directory is reached through a symlink.
const root = realpathSync(requestedRoot);
const port = Number(option('--port', '3143'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Use a port from 1024 to 65535');
const home = join(root, 'home'), data = join(root, 'data'), tmp = join(root, 'tmp');
for (const path of [home, data, tmp]) mkdirSync(path, { recursive: true, mode: 0o700 });
// Do not inherit credentials or an existing hosted instance's environment.
const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: tmp,
  LANG: process.env.LANG ?? 'C.UTF-8', JARVIS_HOME: data, JARVIS_SECRETS_DIR: data,
  JARVIS_PORT: String(port), JARVIS_PUBLIC_URL: `http://localhost:${port}`, JARVIS_LOCAL_INTEGRATION: '1' };
for (const key of ['TZ', 'SystemRoot', 'SYSTEMROOT', 'WSL_INTEROP', 'WSL_DISTRO_NAME']) if (process.env[key]) env[key] = process.env[key]!;
for (const key of [
  'NAVIGATION_COMPATIBILITY', 'RECONCILIATION', 'ONBOARDING', 'CONVERSATIONS', 'CHAT_TRANSPORT', 'CHAT_STATE',
  'CHAT_ATTACHMENTS', 'CHAT_PROGRESS', 'WORKFLOW_COMPOSITION', 'COMPOSITION_INGREDIENTS', 'PREPARED_OPPORTUNITIES',
  'OPPORTUNITY_ACTIVATION', 'QUIET_AWARENESS', 'DECISIONS', 'DECISION_EDITS', 'RECOMMENDATIONS', 'GOAL_MEASUREMENTS',
  'OUTCOMES', 'MEMORY_STREAM', 'MEMORY_USAGE', 'MEMORY_FORGET', 'WORKFLOW_REMOVAL', 'WORKFLOW_CONTEXT', 'CONNECTIONS', 'PROFILE_SETTINGS',
]) env[`JARVIS_BRIEF_${key}`] = '1';
const enroll = args.includes('--enroll');
const command = enroll ? [process.execPath, '--no-env-file', 'run', 'bin/jarvis.ts', 'enroll', option('--enroll', '')]
  : [process.execPath, '--no-env-file', 'run', 'bin/jarvis.ts', 'start', '--no-open'];
console.error(`Jarvis development data: ${root}\nBrain: http://localhost:${port}\n${enroll ? 'Enrollment uses this same isolated vault.' : 'Enroll from a second terminal using the same --data-dir and --port, plus --enroll "local-acceptance".'}`);
const child = Bun.spawn(command, { cwd: resolve(import.meta.dir, '../..'), env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
