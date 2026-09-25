/**
 * Issue #511: the GitHub PAT must not reach git's argv.
 *
 * It used to travel as `https://<token>@github.com/...`, where `ps` showed it,
 * git handed it to a `pre-push` hook as $2, and `push -u` wrote it into
 * .git/config. Now it goes through a command-line credential helper that reads
 * a 0600 file (credentialHelperArgs).
 *
 * Three layers, each with a reason:
 *   - the helper script itself, run under `sh -c` exactly as git runs it;
 *   - each call site (push, pull, getRemoteStatus) against a fake `git` that
 *     dumps its argv and environment, so the assertion is on what a real
 *     child process received;
 *   - a real `git push`/`pull`/`fetch` against a loopback `git http-backend`
 *     that demands Basic auth. GIT_TRACE records the argv of EVERY process git
 *     starts (remote helper, credential helper, hooks), and a planted pre-push
 *     hook records its arguments, its environment, its parent's command line,
 *     and whatever token file it can find. A positive control runs the old
 *     token-in-URL shape through the same harness and must be caught.
 *
 * POSIX-only, like spawn-env.test.ts: fakes and hooks are `#!/bin/sh`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIAL_DIR_PREFIX, GitHubManager, credentialHelperArgs, sweepStaleCredentialDirs,
} from './github-manager.ts';

/** Synthetic. Never a real token. */
const TOKEN = 'ghp_issue511Canary0123456789abcdefABCD';
/** What a pre-#511 push left in .git/config. Also synthetic. */
const OLD_TOKEN = 'ghp_issue511OldCanary9876543210zyxwvu';

const REAL_GIT = Bun.which('git');

const tmpRoots: string[] = [];
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `jarvis-511-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

// process.env is mutated for PATH (fake/wrapped git), TMPDIR (where the
// credential dir goes), HOME (isolate from the developer's ~/.gitconfig) and
// JARVIS_GITHUB_TOKEN. sanitizedEnv reads it live. Always restored.
const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

afterEach(restoreEnv);
afterAll(() => {
  restoreEnv();
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Files under `dir` containing `needle`. Returns PATHS only: on failure the
 * test reports where the token landed without printing the file.
 */
function filesContaining(dir: string, needle: string): string[] {
  return walk(dir).filter(f => readFileSync(f, 'latin1').includes(needle));
}

function credentialDirsIn(dir: string): string[] {
  return readdirSync(dir).filter(n => n.startsWith(CREDENTIAL_DIR_PREFIX));
}

async function run(cmd: string[], cwd: string, input?: string, env?: Record<string, string>) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
    env: env ?? { PATH: process.env.PATH ?? '' },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, exitCode: await proc.exited };
}

// ── The helper script ──

describe('credentialHelperArgs: the helper git runs', () => {
  const target = { protocol: 'https', host: 'github.com' };

  /** Run the helper the way git does: `sh -c '<snippet> <action>'`. */
  async function invokeHelper(args: string[], action: string, request: string) {
    const snippet = args[3]!.slice('credential.helper=!'.length);
    return run(['sh', '-c', `${snippet} ${action}`], tmpdir(), request);
  }

  function tokenFile(name = 'token'): string {
    const dir = tempRoot('helper');
    const file = join(dir, name);
    writeFileSync(file, TOKEN, { mode: 0o600 });
    return file;
  }

  test('resets the inherited helper list before adding its own, and carries no token', () => {
    const args = credentialHelperArgs('/x/token', target);
    expect(args.slice(0, 3)).toEqual(['-c', 'credential.helper=', '-c']);
    expect(args[3]!.startsWith('credential.helper=!')).toBe(true);
    expect(args.join('\0')).not.toContain(TOKEN);
  });

  test('answers a github.com https request with the token, then deletes the file', async () => {
    const file = tokenFile();
    const out = await invokeHelper(credentialHelperArgs(file, target), 'get', 'protocol=https\nhost=github.com\n\n');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(existsSync(file)).toBe(false);
  });

  test('a second get finds nothing (one-shot)', async () => {
    const file = tokenFile();
    const args = credentialHelperArgs(file, target);
    await invokeHelper(args, 'get', 'protocol=https\nhost=github.com\n\n');
    const again = await invokeHelper(args, 'get', 'protocol=https\nhost=github.com\n\n');
    expect(again.stdout).toBe('');
  });

  const refused: Array<[string, string]> = [
    ['another host (insteadOf / pushurl redirect)', 'protocol=https\nhost=evil.example\n\n'],
    ['a host that merely starts with github.com', 'protocol=https\nhost=github.com.evil.example\n\n'],
    ['a github.com lookalike with a port', 'protocol=https\nhost=github.com:8443\n\n'],
    ['plain http to github.com', 'protocol=http\nhost=github.com\n\n'],
    ['a request with no host at all', 'protocol=https\n\n'],
  ];
  for (const [name, request] of refused) {
    test(`refuses ${name}, and burns the token rather than keep it around`, async () => {
      const file = tokenFile();
      const args = credentialHelperArgs(file, target);
      const out = await invokeHelper(args, 'get', request);
      expect(out.stdout).toBe('');
      expect(existsSync(file)).toBe(false);
      // Fail closed: a redirect first cannot be followed by a real answer.
      const then = await invokeHelper(args, 'get', 'protocol=https\nhost=github.com\n\n');
      expect(then.stdout).toBe('');
    });
  }

  test('ignores store and erase, which git sends WITH the password', async () => {
    const file = tokenFile();
    const args = credentialHelperArgs(file, target);
    for (const action of ['store', 'erase']) {
      const out = await invokeHelper(args, action, `protocol=https\nhost=github.com\nusername=x\npassword=${TOKEN}\n\n`);
      expect(out.stdout).toBe('');
    }
    expect(existsSync(file)).toBe(true);
  });

  test('a path with quotes, spaces and $(...) is quoted, not executed', async () => {
    const file = tokenFile(`it's a $(touch pwned) "file"`);
    const out = await invokeHelper(credentialHelperArgs(file, target), 'get', 'protocol=https\nhost=github.com\n\n');
    expect(out.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(existsSync(join(tmpdir(), 'pwned'))).toBe(false);
  });
});

// ── Stale credential dir sweep ──

describe('sweepStaleCredentialDirs', () => {
  test('removes only our own stale real directories', () => {
    const root = tempRoot('sweep');
    const now = Date.now();
    const stale = join(root, `${CREDENTIAL_DIR_PREFIX}stale`);
    const fresh = join(root, `${CREDENTIAL_DIR_PREFIX}fresh`);
    const unrelated = join(root, 'other-stale');
    const victim = join(root, 'victim');
    for (const d of [stale, fresh, unrelated, victim]) mkdirSync(d);
    writeFileSync(join(stale, 'token'), TOKEN);
    writeFileSync(join(victim, 'keep'), 'x');
    const link = join(root, `${CREDENTIAL_DIR_PREFIX}link`);
    symlinkSync(victim, link);
    const old = new Date(now - 60 * 60_000);
    for (const d of [stale, unrelated, victim]) utimesSync(d, old, old);

    sweepStaleCredentialDirs(root, now);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(victim, 'keep'))).toBe(true);
  });

  test('a missing root is not an error', () => {
    expect(() => sweepStaleCredentialDirs(join(tmpdir(), 'jarvis-511-does-not-exist'))).not.toThrow();
  });
});

// ── Per call site, against a fake git ──

describe('each call site keeps the token out of git argv and env', () => {
  type Invocation = { argv: string[]; env: string; cred: string | null };

  /**
   * A fake `git` that records its argv (NUL-separated) and env, answers the
   * two queries the manager makes, and -- if handed our credential helper --
   * runs it the way git would, so the test also proves the token was
   * deliverable while git was running.
   */
  function setupFakeGit(): { project: string; logDir: string; tmp: string; invocations: () => Invocation[] } {
    const root = tempRoot('fake');
    const bin = join(root, 'bin');
    const logDir = join(root, 'log');
    const project = join(root, 'project');
    const tmp = join(root, 'tmp');
    for (const d of [bin, logDir, project, tmp]) mkdirSync(d);

    // The log path is baked into the script: the environment is the channel
    // under test and sanitizedEnv would strip anything we passed through it.
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      `log="${logDir}/$(date +%s%N).$$"`,
      'printf "%s\\0" "$@" > "$log.argv"',
      'env > "$log.env"',
      'helper=; prev=',
      'for a in "$@"; do',
      '  if [ "$prev" = "-c" ]; then case "$a" in "credential.helper=!"*) helper="${a#credential.helper=!}";; esac; fi',
      '  prev="$a"',
      'done',
      'if [ -n "$helper" ]; then',
      '  printf "protocol=https\\nhost=github.com\\n\\n" | sh -c "$helper get" > "$log.cred"',
      'fi',
      'case "$*" in',
      '  *"remote get-url origin"*) echo https://github.com/owner/repo.git ;;',
      '  *"branch --show-current"*) echo main ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      'exit 0',
    ].join('\n'), { mode: 0o755 });

    setEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    setEnv('TMPDIR', tmp);
    setEnv('XDG_RUNTIME_DIR', tmp);
    setEnv('JARVIS_GITHUB_TOKEN', TOKEN);

    const invocations = () => readdirSync(logDir)
      .filter(f => f.endsWith('.argv'))
      .sort()
      .map((f) => {
        const base = join(logDir, f.slice(0, -'.argv'.length));
        const argv = readFileSync(`${base}.argv`, 'utf8').split('\0');
        argv.pop();
        return {
          argv,
          env: readFileSync(`${base}.env`, 'utf8'),
          cred: existsSync(`${base}.cred`) ? readFileSync(`${base}.cred`, 'utf8') : null,
        };
      });

    return { project, logDir, tmp, invocations };
  }

  /** The assertions every call site must satisfy. */
  function expectTokenOnlyViaHelper(invocations: Invocation[], subcommand: string, tmp: string) {
    const network = invocations.filter(i => i.argv.includes(subcommand));
    expect(network.length).toBe(1);

    // No spawn carried the token in argv or env. Report indexes, not values.
    const argvLeaks = invocations.flatMap((i, n) => i.argv.some(a => a.includes(TOKEN)) ? [n] : []);
    const envLeaks = invocations.flatMap((i, n) => i.env.includes(TOKEN) ? [n] : []);
    expect({ argvLeaks, envLeaks }).toEqual({ argvLeaks: [], envLeaks: [] });

    // No URL among any subcommand's arguments: the remote is addressed by
    // name. (The `-c http.<url>.proactiveAuth` key before it is config.)
    const urls = invocations.flatMap((i) => {
      const firstPlain = i.argv.findIndex((a, n) => !a.startsWith('-') && i.argv[n - 1] !== '-c');
      return i.argv.slice(firstPlain).filter(a => /:\/\//.test(a));
    });
    expect(urls).toEqual([]);
    expect(network[0]!.argv).toContain('origin');
    expect(network[0]!.argv).toContain('protocol.allow=never');

    // Positive: the helper handed git the token while it ran.
    expect(network[0]!.cred).toBe(`username=x-access-token\npassword=${TOKEN}\n`);

    // And cleaned up after itself.
    expect(credentialDirsIn(tmp)).toEqual([]);
  }

  test('push', async () => {
    const fake = setupFakeGit();
    const result = await new GitHubManager().push(fake.project);
    expect(result).toEqual({ success: true });
    expectTokenOnlyViaHelper(fake.invocations(), 'push', fake.tmp);
    const push = fake.invocations().find(i => i.argv.includes('push'))!;
    expect(push.argv.slice(push.argv.indexOf('push'))).toEqual(['push', '-u', 'origin', 'main']);
  });

  test('push --force', async () => {
    const fake = setupFakeGit();
    await new GitHubManager().push(fake.project, 'feature', true);
    expectTokenOnlyViaHelper(fake.invocations(), 'push', fake.tmp);
    const push = fake.invocations().find(i => i.argv.includes('push'))!;
    expect(push.argv.slice(push.argv.indexOf('push'))).toEqual(['push', '--force', '-u', 'origin', 'feature']);
  });

  test('pull', async () => {
    const fake = setupFakeGit();
    const result = await new GitHubManager().pull(fake.project);
    expect(result).toEqual({ success: true });
    expectTokenOnlyViaHelper(fake.invocations(), 'pull', fake.tmp);
  });

  test('getRemoteStatus (fetch)', async () => {
    const fake = setupFakeGit();
    const status = await new GitHubManager().getRemoteStatus(fake.project);
    expect(status.hasRemote).toBe(true);
    expectTokenOnlyViaHelper(fake.invocations(), 'fetch', fake.tmp);
  });

  test('a failing git spawn still removes the credential dir', async () => {
    const fake = setupFakeGit();
    // Make the network call fail after the credential dir exists.
    writeFileSync(join(fake.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *"remote get-url origin"*) echo https://github.com/owner/repo.git; exit 0 ;;',
      '  *"branch --show-current"*) echo main; exit 0 ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      'echo "fatal: remote rejected" >&2',
      'exit 128',
    ].join('\n'), { mode: 0o755 });

    const result = await new GitHubManager().push(fake.project);
    expect(result.success).toBe(false);
    expect(result.error).toContain('git push failed');
    expect(credentialDirsIn(fake.tmp)).toEqual([]);
  });

  test('a git that hangs is killed at the timeout, and the credential dir still goes', async () => {
    const fake = setupFakeGit();
    // `exec` so the kill lands on sleep itself and nothing is orphaned.
    writeFileSync(join(fake.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *"remote get-url origin"*) echo https://github.com/owner/repo.git; exit 0 ;;',
      '  *"branch --show-current"*) echo main; exit 0 ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      'exec sleep 30',
    ].join('\n'), { mode: 0o755 });

    const started = Date.now();
    const result = await new GitHubManager({ networkTimeoutMs: 300 }).push(fake.project);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(credentialDirsIn(fake.tmp)).toEqual([]);
  });

  test('a branch that git would parse as an option is refused', async () => {
    const fake = setupFakeGit();
    for (const branch of ['--receive-pack=touch pwned', '-f']) {
      expect((await new GitHubManager().push(fake.project, branch)).success).toBe(false);
      expect((await new GitHubManager().pull(fake.project, branch)).success).toBe(false);
    }
    const network = fake.invocations().filter(i => i.argv.includes('push') || i.argv.includes('pull'));
    expect(network).toEqual([]);
  });

  test('a token that cannot be a token never reaches git', async () => {
    const fake = setupFakeGit();
    setEnv('JARVIS_GITHUB_TOKEN', `${TOKEN}\nhost=evil.example`);
    const result = await new GitHubManager().push(fake.project);
    expect(result.success).toBe(false);
    expect(result.error).not.toContain(TOKEN);
    expect(fake.invocations().filter(i => i.argv.includes('push'))).toEqual([]);
    expect(credentialDirsIn(fake.tmp)).toEqual([]);
  });
});

// ── Real git over smart HTTP ──

/**
 * A loopback smart-HTTP git server: `git http-backend` as CGI behind Basic
 * auth. It records only whether each request carried the right credential,
 * never the header itself. Repos named `public-*` behave like a public GitHub
 * repo: fetching needs no auth, so git is never challenged.
 */
function startGitServer(repoRoot: string, gitBinary: string) {
  const requests: Array<{ path: string; auth: 'none' | 'ok' | 'wrong' }> = [];
  const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const header = req.headers.get('authorization');
      const auth = header === null ? 'none' : header === expected ? 'ok' : 'wrong';
      requests.push({ path: `${req.method} ${url.pathname}${url.search}`, auth });
      const publicRead = url.pathname.startsWith('/public-') && `${url.pathname}${url.search}`.includes('git-upload-pack');
      if (auth !== 'ok' && !(publicRead && auth === 'none')) {
        return new Response('auth required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="t"' } });
      }

      const body = new Uint8Array(await req.arrayBuffer());
      const proc = Bun.spawn([gitBinary, 'http-backend'], {
        stdin: body,
        stdout: 'pipe',
        stderr: 'ignore',
        env: {
          PATH: '/usr/bin:/bin',
          GIT_PROJECT_ROOT: repoRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          // http-backend refuses receive-pack to an anonymous user.
          REMOTE_USER: 'x-access-token',
          REQUEST_METHOD: req.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers.get('content-type') ?? '',
          CONTENT_LENGTH: String(body.length),
          HTTP_CONTENT_ENCODING: req.headers.get('content-encoding') ?? '',
          GIT_PROTOCOL: req.headers.get('git-protocol') ?? '',
        },
      });
      const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      await proc.exited;

      // CGI response: headers, blank line, body.
      const split = out.indexOf('\r\n\r\n');
      const headers = new Headers();
      let status = 200;
      for (const line of out.subarray(0, split).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = parseInt(value, 10);
        else headers.append(name, value);
      }
      return new Response(out.subarray(split + 4), { status, headers });
    },
  });
  return { server, requests, base: `http://127.0.0.1:${server.port}`, host: `127.0.0.1:${server.port}` };
}

// Linux-only: the hook samples /proc and the modes check uses GNU stat.
describe.skipIf(process.platform !== 'linux' || !REAL_GIT)('a real push/pull/fetch over HTTP', () => {
  let server: ReturnType<typeof startGitServer>;
  let root: string;
  let bare: string;

  beforeAll(() => {
    root = tempRoot('http');
    bare = join(root, 'srv');
    mkdirSync(bare);
    server = startGitServer(bare, REAL_GIT!);
  });
  afterAll(() => server?.server.stop(true));

  type Harness = {
    project: string;
    /** This project's own bare repo on the server, so tests cannot collide. */
    bareRepo: string;
    evidence: string;
    tmp: string;
    /** Every place a leak would show up, reported as labels, never values. */
    leaks: (needle: string) => string[];
    gitEnv: Record<string, string>;
  };

  /**
   * A project with the hostile furniture a model-written tree could carry, and
   * a PATH-wrapped git that records every argv:
   *   - bin/git logs its own argv, then sets GIT_TRACE so real git logs the
   *     argv of every process IT starts (remote helper, credential helper,
   *     hooks);
   *   - a local credential helper, plain and URL-scoped, that appends whatever
   *     git sends it (git sends the password on `store`);
   *   - a pre-push hook that records $1/$2, its environment, its parent git's
   *     /proc cmdline, and any token file it can find under TMPDIR.
   */
  async function setupProject(label: string): Promise<Harness> {
    const base = tempRoot(`proj-${label}`);
    const bin = join(base, 'bin');
    const evidence = join(base, 'evidence');
    const project = join(base, 'project');
    const home = join(base, 'home');
    const tmp = join(base, 'tmp');
    for (const d of [bin, evidence, project, home, tmp]) mkdirSync(d);

    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      `printf "%s\\0" "$@" > "${evidence}/argv.$$.$(date +%s%N)"`,
      `GIT_TRACE="${evidence}/trace"; export GIT_TRACE`,
      `exec "${REAL_GIT}" "$@"`,
    ].join('\n'), { mode: 0o755 });

    const gitEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, GIT_TERMINAL_PROMPT: '0' };
    const bareRepo = join(bare, `${label}.git`);
    await run([REAL_GIT!, 'init', '-q', '--bare', '-b', 'main', bareRepo], root, undefined, gitEnv);
    const g = (args: string[]) => run([REAL_GIT!, ...args], project, undefined, gitEnv);
    await g(['init', '-q', '-b', 'main']);
    await g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', `init ${label}`]);
    await g(['remote', 'add', 'origin', `${server.base}/${label}.git`]);

    const steal = `!f() { cat >> '${evidence}/stolen-by-helper'; }; f`;
    await g(['config', 'credential.helper', steal]);
    await g(['config', `credential.${server.base}.helper`, steal]);

    // reference-transaction fires on every ref update, fetch included, so it
    // covers the operations where no pre-push runs.
    for (const hook of ['pre-push', 'reference-transaction']) {
      writeFileSync(join(project, '.git', 'hooks', hook), [
        '#!/bin/sh',
        `out="${evidence}/hook.${hook}.$$.$(date +%s%N)"`,
        'printf "%s\\n%s\\n" "$1" "$2" > "$out.args"',
        'env > "$out.env"',
        'tr "\\0" " " < /proc/$PPID/cmdline > "$out.parent-cmdline" 2>/dev/null',
        'cat "$TMPDIR"/*/token > "$out.found-token-file" 2>/dev/null',
        // reference-transaction gets the ref updates on stdin.
        'cat > /dev/null',
        'exit 0',
      ].join('\n'), { mode: 0o755 });
    }

    const leaks = (needle: string) => {
      const found: string[] = [];
      for (const f of filesContaining(evidence, needle)) found.push(`evidence/${f.slice(evidence.length + 1)}`);
      for (const f of filesContaining(join(project, '.git'), needle)) found.push(`.git/${f.slice(project.length + 6)}`);
      for (const f of filesContaining(tmp, needle)) found.push(`tmp/${f.slice(tmp.length + 1)}`);
      return found;
    };

    return { project, bareRepo, evidence, tmp, leaks, gitEnv };
  }

  function useHarnessEnv(h: Harness) {
    for (const [k, v] of Object.entries(h.gitEnv)) setEnv(k, v);
    setEnv('XDG_RUNTIME_DIR', h.tmp);
    setEnv('JARVIS_GITHUB_TOKEN', TOKEN);
  }

  function hookRuns(h: Harness, hook: 'pre-push' | 'reference-transaction'): string[] {
    return readdirSync(h.evidence).filter(f => f.startsWith(`hook.${hook}.`) && f.endsWith('.args'));
  }

  /** Hook runs that managed to read a token file, as labels. */
  function hookRunsThatFoundAToken(h: Harness): string[] {
    return readdirSync(h.evidence)
      .filter(f => f.endsWith('.found-token-file'))
      .filter(f => readFileSync(join(h.evidence, f), 'utf8') !== '');
  }

  function manager(): GitHubManager {
    return new GitHubManager({ credentialTarget: { protocol: 'http', host: server.host } });
  }

  // If this fails, the "no leak" assertions below prove nothing.
  test('CONTROL: the harness catches the pre-#511 token-in-URL push', async () => {
    const h = await setupProject('control');
    const tokenUrl = `http://x-access-token:${TOKEN}@${server.host}/control.git`;
    const pushed = await run(['git', 'push', '-u', tokenUrl, 'main'], h.project, undefined, h.gitEnv);
    expect(pushed.exitCode).toBe(0);

    const leaks = h.leaks(TOKEN);
    // argv of the top-level git, argv of git-remote-http via GIT_TRACE, the
    // pre-push hook's $2, and .git/config via `push -u`.
    expect(leaks.some(l => l.startsWith('evidence/argv.'))).toBe(true);
    expect(leaks).toContain('evidence/trace');
    expect(leaks.some(l => /^evidence\/hook\.pre-push\..*\.args$/.test(l))).toBe(true);
    expect(leaks).toContain('.git/config');
  }, 30_000);

  // Same, for the token-file probe: a hook that runs while the file exists
  // must be seen to find it.
  test('CONTROL: the hook probe finds a token file that is present', async () => {
    const h = await setupProject('control-probe');
    const planted = join(h.tmp, `${CREDENTIAL_DIR_PREFIX}planted`);
    mkdirSync(planted);
    writeFileSync(join(planted, 'token'), TOKEN);
    // A local push: no auth needed, so pre-push runs with the file in place.
    const local = await run(['git', 'push', h.bareRepo, 'main'], h.project, undefined, h.gitEnv);
    expect(local.exitCode).toBe(0);
    expect(hookRunsThatFoundAToken(h).length).toBeGreaterThan(0);
  }, 30_000);

  test('push: authenticates, and the token is nowhere a hook, ps or .git can see', async () => {
    const h = await setupProject('push');
    // What a pre-#511 push left behind, to be scrubbed.
    await run([REAL_GIT!, 'config', 'branch.stale.remote', `https://x-access-token:${OLD_TOKEN}@github.com/o/r.git`],
      h.project, undefined, h.gitEnv);
    useHarnessEnv(h);

    const before = server.requests.length;
    const result = await manager().push(h.project);
    expect(result).toEqual({ success: true });

    // The helper really delivered the token: the server saw it, on the very
    // first request (proactive auth), and never a wrong one.
    const seen = server.requests.slice(before);
    expect(seen.some(r => r.path.includes('git-receive-pack') && r.auth === 'ok')).toBe(true);
    expect(seen.filter(r => r.auth !== 'ok')).toEqual([]);

    // The hook ran, got a tokenless URL, and found no token file to read.
    const runs = hookRuns(h, 'pre-push');
    expect(runs.length).toBe(1);
    const [remoteName, remoteUrl] = readFileSync(join(h.evidence, runs[0]!), 'utf8').split('\n');
    expect(remoteName).toBe('origin');
    expect(remoteUrl).toBe(`${server.base}/push.git`);
    expect(hookRunsThatFoundAToken(h)).toEqual([]);
    // The parent-cmdline sample is real evidence, not an empty file.
    expect(readFileSync(join(h.evidence, runs[0]!.replace(/\.args$/, '.parent-cmdline')), 'utf8')).toContain('push');

    // Not in any argv (top-level or GIT_TRACE'd children), hook env, parent
    // cmdline, the hostile helper's loot, anywhere under .git, or tmp.
    expect(h.leaks(TOKEN)).toEqual([]);
    expect(existsSync(join(h.evidence, 'stolen-by-helper'))).toBe(false);
    expect(credentialDirsIn(h.tmp)).toEqual([]);

    // `-u` recorded the remote name, and the old leak was scrubbed.
    const config = readFileSync(join(h.project, '.git', 'config'), 'utf8');
    expect(config).not.toContain(OLD_TOKEN);
    const upstream = await run([REAL_GIT!, 'config', 'branch.main.remote'], h.project, undefined, h.gitEnv);
    expect(upstream.stdout.trim()).toBe('origin');
    const stale = await run([REAL_GIT!, 'config', 'branch.stale.remote'], h.project, undefined, h.gitEnv);
    expect(stale.stdout.trim()).toBe('origin');
  }, 30_000);

  test('fetch and pull: FETCH_HEAD, reflogs and config stay clean, and ahead/behind now works', async () => {
    const h = await setupProject('pull');
    useHarnessEnv(h);
    const m = manager();
    expect((await m.push(h.project)).success).toBe(true);

    // Someone else pushes a commit straight into the bare repo.
    const other = join(tempRoot('other'), 'clone');
    await run([REAL_GIT!, 'clone', '-q', h.bareRepo, other], root, undefined, h.gitEnv);
    await run([REAL_GIT!, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '--allow-empty', '-m', 'upstream'],
      other, undefined, h.gitEnv);
    await run([REAL_GIT!, 'push', '-q', 'origin', 'main'], other, undefined, h.gitEnv);

    const status = await m.getRemoteStatus(h.project);
    // Fetching by remote name updates origin/main, so this is now accurate.
    expect({ ahead: status.ahead, behind: status.behind }).toEqual({ ahead: 0, behind: 1 });
    expect(existsSync(join(h.project, '.git', 'FETCH_HEAD'))).toBe(true);

    const pulled = await m.pull(h.project);
    expect(pulled).toEqual({ success: true });
    const after = await m.getRemoteStatus(h.project);
    expect(after.behind).toBe(0);

    // reference-transaction ran during fetch and pull and found nothing.
    expect(hookRuns(h, 'reference-transaction').length).toBeGreaterThan(0);
    expect(hookRunsThatFoundAToken(h)).toEqual([]);
    expect(h.leaks(TOKEN)).toEqual([]);
    expect(existsSync(join(h.evidence, 'stolen-by-helper'))).toBe(false);
    expect(credentialDirsIn(h.tmp)).toEqual([]);
    // No URL, tokenized or not, is written into the reflog any more.
    expect(readFileSync(join(h.project, '.git', 'logs', 'HEAD'), 'utf8')).toContain('pull origin main');
  }, 60_000);

  test('a public repo, which never challenges, still consumes the token before any hook runs', async () => {
    const h = await setupProject('public-fetch');
    useHarnessEnv(h);
    const m = manager();
    expect((await m.push(h.project)).success).toBe(true);
    const other = join(tempRoot('other'), 'clone');
    await run([REAL_GIT!, 'clone', '-q', h.bareRepo, other], root, undefined, h.gitEnv);
    await run([REAL_GIT!, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '--allow-empty', '-m', 'up'],
      other, undefined, h.gitEnv);
    await run([REAL_GIT!, 'push', '-q', 'origin', 'main'], other, undefined, h.gitEnv);

    const before = server.requests.length;
    const status = await m.getRemoteStatus(h.project);
    expect(status.behind).toBe(1);

    // The server would have answered anonymously, yet the helper was asked
    // up front, so the file was gone before reference-transaction ran.
    const seen = server.requests.slice(before);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(r => r.auth !== 'ok')).toEqual([]);
    expect(hookRuns(h, 'reference-transaction').length).toBeGreaterThan(0);
    expect(hookRunsThatFoundAToken(h)).toEqual([]);
    expect(h.leaks(TOKEN)).toEqual([]);
  }, 60_000);

  test('a local-path pushurl ahead of origin cannot run pre-push while the token exists', async () => {
    const h = await setupProject('pushurl');
    const decoy = join(tempRoot('decoy'), 'decoy.git');
    await run([REAL_GIT!, 'init', '-q', '--bare', decoy], root, undefined, h.gitEnv);
    await run([REAL_GIT!, 'config', '--add', 'remote.origin.pushurl', decoy], h.project, undefined, h.gitEnv);
    await run([REAL_GIT!, 'config', '--add', 'remote.origin.pushurl', `${server.base}/pushurl.git`], h.project, undefined, h.gitEnv);
    useHarnessEnv(h);

    const result = await manager().push(h.project);
    // The file transport is refused, so the push as a whole reports failure.
    expect(result.success).toBe(false);
    expect(result.error).toContain("transport 'file' not allowed");
    expect(readdirSync(join(decoy, 'refs', 'heads'))).toEqual([]);
    expect(hookRunsThatFoundAToken(h)).toEqual([]);
    expect(h.leaks(TOKEN)).toEqual([]);
    expect(credentialDirsIn(h.tmp)).toEqual([]);
  }, 30_000);

  test('an insteadOf redirect to another host gets no credential at all', async () => {
    const h = await setupProject('redirect');
    const elsewhere = startGitServer(bare, REAL_GIT!);
    try {
      await run([REAL_GIT!, 'config', `url.${elsewhere.base}/.insteadOf`, `${server.base}/`], h.project, undefined, h.gitEnv);
      useHarnessEnv(h);

      const result = await manager().push(h.project);
      expect(result.success).toBe(false);
      expect(elsewhere.requests.filter(r => r.auth !== 'none')).toEqual([]);
      expect(hookRunsThatFoundAToken(h)).toEqual([]);
      expect(h.leaks(TOKEN)).toEqual([]);
      expect(credentialDirsIn(h.tmp)).toEqual([]);
    } finally {
      elsewhere.server.stop(true);
    }
  }, 30_000);

  test('status scrubs an old token URL even when no token is configured', async () => {
    const h = await setupProject('scrub');
    await run([REAL_GIT!, 'config', 'branch.main.remote', `https://x-access-token:${OLD_TOKEN}@github.com/o/r.git`],
      h.project, undefined, h.gitEnv);
    useHarnessEnv(h);
    setEnv('JARVIS_GITHUB_TOKEN', undefined);
    // Point the keychain at an empty dir so no real token can be picked up.
    setEnv('JARVIS_SECRETS_DIR', tempRoot('no-secrets'));

    const before = server.requests.length;
    await manager().getRemoteStatus(h.project);
    expect(server.requests.length).toBe(before);
    expect(readFileSync(join(h.project, '.git', 'config'), 'utf8')).not.toContain(OLD_TOKEN);
  }, 30_000);

  test('the credential dir is 0700 and the token file 0600 while git runs', async () => {
    const h = await setupProject('modes');
    // The dir and file exist before git is spawned, so the PATH wrapper can
    // record their modes just before it execs the real git.
    writeFileSync(join(h.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      `for d in "$TMPDIR"/${CREDENTIAL_DIR_PREFIX}*; do [ -d "$d" ] && stat -c "%a %n" "$d" "$d"/token >> "${h.evidence}/modes"; done`,
      `exec "${REAL_GIT}" "$@"`,
    ].join('\n'), { mode: 0o755 });
    useHarnessEnv(h);

    expect((await manager().push(h.project)).success).toBe(true);
    const modes = readFileSync(join(h.evidence, 'modes'), 'utf8').trim().split('\n').map(l => l.split(' ')[0]);
    expect(modes).toEqual(['700', '600']);
    expect(credentialDirsIn(h.tmp)).toEqual([]);
  }, 30_000);
});
