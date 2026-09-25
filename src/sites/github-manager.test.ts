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
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIAL_DIR_PREFIX, GitHubManager, credentialHelperArgs, credentialRoot, gitHardeningArgs, sweepStaleCredentialDirs,
} from './github-manager.ts';

/** Synthetic. Never a real token. */
const TOKEN = 'ghp_issue511Canary0123456789abcdefABCD';
/** What a pre-#511 push left in .git/config. Also synthetic. */
const OLD_TOKEN = 'ghp_issue511OldCanary9876543210zyxwvu';

const REAL_GIT = Bun.which('git');

/**
 * `http.<url>.proactiveAuth` arrived in git 2.46; older git ignores the key
 * and authenticates after a 401 as before. The assertions that depend on it
 * are skipped there rather than left to fail on a stock distro git.
 */
const GIT_HAS_PROACTIVE_AUTH = (() => {
  if (!REAL_GIT) return false;
  const out = Bun.spawnSync([REAL_GIT, '--version']).stdout.toString();
  const [major = 0, minor = 0] = (out.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  return major > 2 || (major === 2 && minor >= 46);
})();

/**
 * The loopback server needs `git http-backend`, which some distros package
 * separately (Alpine's git-daemon). Probed by its presence in the exec path.
 */
const HAS_HTTP_BACKEND = (() => {
  if (!REAL_GIT) return false;
  const execPath = Bun.spawnSync([REAL_GIT, '--exec-path']).stdout.toString().trim();
  return execPath !== '' && existsSync(join(execPath, 'git-http-backend'));
})();

const tmpRoots: string[] = [];
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `jarvis-511-${label}-`));
  tmpRoots.push(dir);
  return dir;
}

// process.env is mutated for PATH (fake/wrapped git), TMPDIR and
// XDG_RUNTIME_DIR (where the credential dir goes), HOME (isolate from the
// developer's ~/.gitconfig), the locale, and JARVIS_GITHUB_TOKEN. sanitizedEnv
// reads it live. Always restored after each test. This relies on bun running
// the tests of a file one at a time: do not opt this file into
// test.concurrent.
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

/**
 * A killed process is gone once its /proc entry is, or while it is only a
 * zombie waiting for init to reap it -- which on a loaded machine can take a
 * moment after the kill.
 */
function isGone(pid: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return true;
  }
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

/**
 * `run` for setup steps. A setup command that silently failed (a config that
 * was never written, a stale entry never planted) would let a "nothing
 * leaked" assertion pass without testing anything.
 */
async function setup(cmd: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const result = await run(cmd, cwd, undefined, { ...env, GIT_CONFIG_NOSYSTEM: '1' });
  if (result.exitCode !== 0) throw new Error(`setup failed (${cmd.slice(1, 3).join(' ')}): ${result.stderr.trim()}`);
  return result.stdout;
}

// ── The helper script ──

describe('credentialHelperArgs: the helper git runs', () => {
  const target = { protocol: 'https', host: 'github.com' };

  /** Run the helper the way git does: `sh -c '<snippet> <action>'`. */
  async function invokeHelper(args: string[], action: string, request: string, cwd = tmpdir()) {
    const snippet = args[3]!.slice('credential.helper=!'.length);
    return run(['sh', '-c', `${snippet} ${action}`], cwd, request);
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
    const cwd = tempRoot('quoting');
    const out = await invokeHelper(credentialHelperArgs(file, target), 'get', 'protocol=https\nhost=github.com\n\n', cwd);
    expect(out.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(existsSync(join(cwd, 'pwned'))).toBe(false);
  });
});

// ── Stale credential dir sweep ──

describe.skipIf(process.platform === 'win32')('credentialRoot', () => {
  test('uses XDG_RUNTIME_DIR only when it is our own private directory', () => {
    const base = tempRoot('xdg');
    const fallback = join(base, 'tmp');
    mkdirSync(fallback);
    setEnv('TMPDIR', fallback);

    const good = join(base, 'good');
    mkdirSync(good, { mode: 0o700 });
    setEnv('XDG_RUNTIME_DIR', good);
    expect(credentialRoot()).toBe(good);

    const open = join(base, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    setEnv('XDG_RUNTIME_DIR', open);
    expect(credentialRoot()).toBe(fallback);

    setEnv('XDG_RUNTIME_DIR', join(base, 'missing'));
    expect(credentialRoot()).toBe(fallback);

    setEnv('XDG_RUNTIME_DIR', 'relative/dir');
    expect(credentialRoot()).toBe(fallback);
  });
});

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
  type Invocation = { argv: string[]; env: string; cred: string | null; sawCredentialDir: boolean };

  /**
   * A fake `git` that records its argv (NUL-separated) and env, answers the
   * two queries the manager makes, and -- if handed our credential helper --
   * runs it the way git would, so the test also proves the token was
   * deliverable while git was running.
   */
  function setupFakeGit(
    currentBranch = 'main',
    originUrl = 'https://github.com/owner/repo.git',
  ): { project: string; logDir: string; tmp: string; invocations: () => Invocation[] } {
    const root = tempRoot('fake');
    // Read by the fake rather than interpolated, so any branch text is inert.
    writeFileSync(join(root, 'current-branch'), `${currentBranch}\n`);
    writeFileSync(join(root, 'origin-url'), `${originUrl}\n`);
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
      // Whether a credential dir existed while this git ran.
      `ls "${tmp}" > "$log.tmpls"`,
      'helper=; prev=',
      'for a in "$@"; do',
      '  if [ "$prev" = "-c" ]; then case "$a" in "credential.helper=!"*) helper="${a#credential.helper=!}";; esac; fi',
      '  prev="$a"',
      'done',
      'if [ -n "$helper" ]; then',
      '  printf "protocol=https\\nhost=github.com\\n\\n" | sh -c "$helper get" > "$log.cred"',
      'fi',
      'case "$*" in',
      '  *"get-url"*) cat "$(dirname "$0")/../origin-url" ;;',
      `  *"branch --show-current"*) cat "${root}/current-branch" ;;`,
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
          sawCredentialDir: readFileSync(`${base}.tmpls`, 'utf8').includes(CREDENTIAL_DIR_PREFIX),
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
    expect(network[0]!.argv).toContain('core.fsmonitor=false');

    // Positive: the helper handed git the token while it ran.
    expect(network[0]!.cred).toBe(`username=x-access-token\npassword=${TOKEN}\n`);

    // The token file existed for that one command and no other.
    expect(invocations.filter(i => i.sawCredentialDir).length).toBe(1);

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

  test('pull: fetches with the token, then pulls locally without it', async () => {
    const fake = setupFakeGit();
    const result = await new GitHubManager().pull(fake.project);
    expect(result).toEqual({ success: true });
    expectTokenOnlyViaHelper(fake.invocations(), 'fetch', fake.tmp);
    const fetch = fake.invocations().find(i => i.argv.includes('fetch'))!;
    expect(fetch.argv.slice(fetch.argv.indexOf('fetch'))).toEqual(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    const pull = fake.invocations().find(i => i.argv.includes('pull'))!;
    expect(pull.argv).toEqual(['pull', '.', 'refs/remotes/origin/main']);
    expect(pull.sawCredentialDir).toBe(false);
  });

  // S4: the token is for GitHub over https. Anything else gets plain git and
  // no token file at all -- and keeps working as it did before #511.
  for (const origin of ['git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git', 'https://ghe.example/o/r.git']) {
    test(`a non-GitHub-https origin (${origin}) runs without the token`, async () => {
      const fake = setupFakeGit('main', origin);
      const manager = new GitHubManager();
      expect(await manager.push(fake.project)).toEqual({ success: true });
      expect(await manager.pull(fake.project)).toEqual({ success: true });
      expect((await manager.getRemoteStatus(fake.project)).hasRemote).toBe(true);

      const invocations = fake.invocations();
      for (const sub of ['push', 'pull', 'fetch']) {
        const network = invocations.filter(i => i.argv.includes(sub));
        expect({ sub, count: network.length }).toEqual({ sub, count: 1 });
        // The inherited-helper reset still applies; our helper does not.
        expect(network[0]!.argv).toContain('credential.helper=');
        expect(network[0]!.argv.some(a => a.startsWith('credential.helper=!'))).toBe(false);
      }
      expect(invocations.filter(i => i.sawCredentialDir).length).toBe(0);
      expect(invocations.filter(i => i.argv.some(a => a.includes(TOKEN)) || i.env.includes(TOKEN)).length).toBe(0);
    });
  }

  test('a failing non-GitHub origin says the token was not used, and why', async () => {
    const fake = setupFakeGit('main', 'git@github.com:owner/repo.git');
    writeFileSync(join(fake.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *"get-url"*) cat "$(dirname "$0")/../origin-url"; exit 0 ;;',
      '  *"branch --show-current"*) echo main; exit 0 ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      'echo "git@github.com: Permission denied (publickey)." >&2',
      'exit 128',
    ].join('\n'), { mode: 0o755 });
    const result = await new GitHubManager().push(fake.project);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
    expect(result.error).toContain('so the GitHub token was not used');
  });

  test('an origin whose push URL leaves GitHub gets no token, even if the fetch URL is fine', async () => {
    const fake = setupFakeGit();
    // Answer the --push query with somewhere else.
    writeFileSync(join(fake.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      `ls "${fake.tmp}" > "${fake.logDir}/$(date +%s%N).$$.tmpls"`,
      'case "$*" in',
      '  *"get-url --push"*) echo /tmp/decoy.git; exit 0 ;;',
      '  *"get-url"*) cat "$(dirname "$0")/../origin-url"; exit 0 ;;',
      '  *"branch --show-current"*) echo main; exit 0 ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    expect((await new GitHubManager().push(fake.project)).success).toBe(true);
    const sightings = readdirSync(fake.logDir).filter(f => f.endsWith('.tmpls'))
      .filter(f => readFileSync(join(fake.logDir, f), 'utf8').includes(CREDENTIAL_DIR_PREFIX));
    expect(sightings.length).toBe(0);
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
      '  *"get-url"*) cat "$(dirname "$0")/../origin-url"; exit 0 ;;',
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
      '  *"get-url"*) cat "$(dirname "$0")/../origin-url"; exit 0 ;;',
      '  *"branch --show-current"*) echo main; exit 0 ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      // Short enough that a broken kill cannot outlive the run for long.
      'exec sleep 5',
    ].join('\n'), { mode: 0o755 });

    const started = Date.now();
    const result = await new GitHubManager({ networkTimeoutMs: 300 }).push(fake.project);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(credentialDirsIn(fake.tmp)).toEqual([]);
  }, 15_000);

  // The realistic hang: git is not the only holder of its pipes. The remote
  // helper (or a hook's background job) inherits them, so killing git alone
  // leaves the reads waiting on the orphan.
  test.skipIf(process.platform !== 'linux')('the timeout also kills the children holding git\'s pipes', async () => {
    const fake = setupFakeGit();
    const pidFile = join(fake.logDir, 'grandchild.pid');
    writeFileSync(join(fake.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *"get-url"*) cat "$(dirname "$0")/../origin-url"; exit 0 ;;',
      '  *"branch --show-current"*) echo main; exit 0 ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      'sleep 5 &',
      `echo $! > "${pidFile}"`,
      'sleep 5',
    ].join('\n'), { mode: 0o755 });

    const started = Date.now();
    const result = await new GitHubManager({ networkTimeoutMs: 300 }).push(fake.project);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.error).toContain('timed out');
    expect(credentialDirsIn(fake.tmp)).toEqual([]);
    expect(isGone(readFileSync(pidFile, 'utf8').trim())).toBe(true);
  }, 15_000);

  // What the group kill cannot reach: a hook's `setsid cmd &` leaves the group
  // and keeps the pipes. The call must still return, shortly after the kill.
  test.skipIf(process.platform !== 'linux' || !Bun.which('setsid'))('the timeout gives up on a pipe holder that escaped the group', async () => {
    const fake = setupFakeGit();
    const pidFile = join(fake.logDir, 'escaped.pid');
    writeFileSync(join(fake.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *"get-url"*) cat "$(dirname "$0")/../origin-url"; exit 0 ;;',
      '  *"branch --show-current"*) echo main; exit 0 ;;',
      '  *"--get-regexp"*) exit 1 ;;',
      'esac',
      `setsid sh -c 'echo $$ > "${pidFile}"; exec sleep 8' &`,
      'exec sleep 8',
    ].join('\n'), { mode: 0o755 });

    try {
      const started = Date.now();
      const result = await new GitHubManager({ networkTimeoutMs: 300 }).push(fake.project);
      expect(Date.now() - started).toBeLessThan(6_000);
      expect(result.error).toContain('timed out');
      expect(credentialDirsIn(fake.tmp)).toEqual([]);
    } finally {
      // It escaped on purpose; don't leave it for the rest of the run.
      try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);

  // `-x` is an option, `+x` a force push, `a:b` a push to a ref nobody named.
  const unsafeBranches = ['--receive-pack=touch pwned', '-f', '+main', 'main:refs/heads/other'];

  test('a branch that git would not read as a plain branch is refused', async () => {
    const fake = setupFakeGit();
    for (const branch of unsafeBranches) {
      expect((await new GitHubManager().push(fake.project, branch)).success).toBe(false);
      expect((await new GitHubManager().pull(fake.project, branch)).success).toBe(false);
    }
    const network = fake.invocations().filter(i => ['push', 'pull', 'fetch'].some(s => i.argv.includes(s)));
    expect(network.length).toBe(0);
  });

  for (const branch of unsafeBranches) {
    test(`...including "${branch}" from .git/HEAD rather than the caller`, async () => {
      const fake = setupFakeGit(branch);
      expect((await new GitHubManager().push(fake.project)).success).toBe(false);
      expect((await new GitHubManager().pull(fake.project)).success).toBe(false);
      const network = fake.invocations().filter(i => ['push', 'pull', 'fetch'].some(s => i.argv.includes(s)));
      expect(network.length).toBe(0);
    });
  }

  test('a token that cannot be a token never reaches git', async () => {
    const fake = setupFakeGit();
    setEnv('JARVIS_GITHUB_TOKEN', `${TOKEN}\nhost=evil.example`);
    const result = await new GitHubManager().push(fake.project);
    expect(result.success).toBe(false);
    expect(result.error).not.toContain(TOKEN);
    expect(fake.invocations().filter(i => i.argv.includes('push')).length).toBe(0);
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
          GIT_CONFIG_NOSYSTEM: '1',
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
      if (split < 0) return new Response('http-backend produced no response', { status: 500 });
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
describe.skipIf(process.platform !== 'linux' || !REAL_GIT || !HAS_HTTP_BACKEND)('a real push/pull/fetch over HTTP', () => {
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
   *   - pre-push and reference-transaction hooks that record $1/$2, their
   *     environment, their parent git's /proc cmdline, and any token file they
   *     can find in the credential root.
   */
  async function setupProject(label: string): Promise<Harness> {
    const base = tempRoot(`proj-${label}`);
    const bin = join(base, 'bin');
    const evidence = join(base, 'evidence');
    const project = join(base, 'project');
    const home = join(base, 'home');
    // 0700 and ours, so credentialRoot() accepts it as XDG_RUNTIME_DIR.
    const tmp = join(base, 'tmp');
    for (const d of [bin, evidence, project, home]) mkdirSync(d);
    mkdirSync(tmp, { mode: 0o700 });

    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      `printf "%s\\0" "$@" > "${evidence}/argv.$$.$(date +%s%N)"`,
      `GIT_TRACE="${evidence}/trace"; export GIT_TRACE`,
      // Independent of the host's /etc/gitconfig.
      'GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_NOSYSTEM',
      `exec "${REAL_GIT}" "$@"`,
    ].join('\n'), { mode: 0o755 });

    // LANG=C: one assertion matches git's English error text.
    const gitEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp, LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
    const bareRepo = join(bare, `${label}.git`);
    await setup([REAL_GIT!, 'init', '-q', '--bare', '-b', 'main', bareRepo], root, gitEnv);
    const g = (args: string[]) => setup([REAL_GIT!, ...args], project, gitEnv);
    await g(['init', '-q', '-b', 'main']);
    await g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', `init ${label}`]);
    await g(['remote', 'add', 'origin', `${server.base}/${label}.git`]);
    // No detached `git maintenance` racing the temp-dir cleanup.
    await g(['config', 'maintenance.auto', 'false']);
    await g(['config', 'gc.auto', '0']);

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
        // An absolute path, baked in: the hook's own env is the channel under
        // test, and a probe that looked in the wrong place would find nothing
        // for every build.
        `cat "${tmp}"/*/token > "$out.found-token-file" 2>/dev/null`,
        // reference-transaction gets the ref updates on stdin.
        'cat > /dev/null',
        'exit 0',
      ].join('\n'), { mode: 0o755 });
    }

    const leaks = (needle: string) => {
      // The recorders must have run, or "found nothing" proves nothing.
      if (!existsSync(join(evidence, 'trace'))) throw new Error('GIT_TRACE wrote nothing: the PATH wrapper was bypassed');
      if (!readdirSync(evidence).some(f => f.startsWith('argv.'))) throw new Error('the argv wrapper never ran');
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
    setEnv('LC_ALL', 'C');
    setEnv('LANGUAGE', undefined);
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

  /** Plant a line a pre-#511 push would have left, and prove it is there. */
  async function plantStaleTokenUrl(h: Harness, branch: string): Promise<void> {
    await setup([REAL_GIT!, 'config', `branch.${branch}.remote`, `https://x-access-token:${OLD_TOKEN}@github.com/o/r.git`],
      h.project, h.gitEnv);
    expect(readFileSync(join(h.project, '.git', 'config'), 'utf8')).toContain(OLD_TOKEN);
  }

  /** Someone else pushes one commit straight into the project's bare repo. */
  async function upstreamCommit(h: Harness): Promise<void> {
    const other = join(tempRoot('other'), 'clone');
    await setup([REAL_GIT!, 'clone', '-q', h.bareRepo, other], root, h.gitEnv);
    await setup([REAL_GIT!, '-c', 'user.name=o', '-c', 'user.email=o@o', 'commit', '-q', '--allow-empty', '-m', 'upstream'],
      other, h.gitEnv);
    await setup([REAL_GIT!, 'push', '-q', 'origin', 'main'], other, h.gitEnv);
  }

  // If this fails, the "no leak" assertions below prove nothing.
  test('CONTROL: the harness catches the pre-#511 token-in-URL push', async () => {
    const h = await setupProject('control');
    const tokenUrl = `http://x-access-token:${TOKEN}@${server.host}/control.git`;
    const pushed = await run(['git', 'push', '-u', tokenUrl, 'main'], h.project, undefined, h.gitEnv);
    expect(pushed.exitCode).toBe(0);

    const leaks = h.leaks(TOKEN);
    // argv of the top-level git, argv of git-remote-http via GIT_TRACE, the
    // pre-push hook's $2 and its /proc sample of the parent's cmdline, the
    // hostile local helper (git `store`s to it), and .git/config via `push -u`.
    expect(leaks.some(l => l.startsWith('evidence/argv.'))).toBe(true);
    expect(leaks).toContain('evidence/trace');
    expect(leaks.some(l => /^evidence\/hook\.pre-push\..*\.args$/.test(l))).toBe(true);
    expect(leaks.some(l => /^evidence\/hook\.pre-push\..*\.parent-cmdline$/.test(l))).toBe(true);
    expect(leaks).toContain('evidence/stolen-by-helper');
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
    await plantStaleTokenUrl(h, 'stale');
    useHarnessEnv(h);

    const before = server.requests.length;
    const result = await manager().push(h.project);
    expect(result).toEqual({ success: true });

    // The helper really delivered the token: the server saw it, and never a
    // wrong one. With proactive auth, not even one anonymous request first.
    const seen = server.requests.slice(before);
    expect(seen.some(r => r.path.includes('git-receive-pack') && r.auth === 'ok')).toBe(true);
    expect(seen.filter(r => r.auth === 'wrong').length).toBe(0);
    if (GIT_HAS_PROACTIVE_AUTH) expect(seen.filter(r => r.auth !== 'ok').length).toBe(0);

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
    expect((await setup([REAL_GIT!, 'config', 'branch.main.remote'], h.project, h.gitEnv)).trim()).toBe('origin');
    expect((await setup([REAL_GIT!, 'config', 'branch.stale.remote'], h.project, h.gitEnv)).trim()).toBe('origin');
  }, 30_000);

  test('fetch and pull: FETCH_HEAD, reflogs and config stay clean, and ahead/behind now works', async () => {
    const h = await setupProject('pull');
    useHarnessEnv(h);
    const m = manager();
    expect((await m.push(h.project)).success).toBe(true);
    await upstreamCommit(h);

    const beforeFetch = hookRuns(h, 'reference-transaction').length;
    const status = await m.getRemoteStatus(h.project);
    // Fetching by remote name updates origin/main, so this is now accurate.
    expect({ ahead: status.ahead, behind: status.behind }).toEqual({ ahead: 0, behind: 1 });
    expect(existsSync(join(h.project, '.git', 'FETCH_HEAD'))).toBe(true);
    // The hook ran during the fetch itself, not only during the setup push.
    const beforePull = hookRuns(h, 'reference-transaction').length;
    expect(beforePull).toBeGreaterThan(beforeFetch);

    const pulled = await m.pull(h.project);
    expect(pulled).toEqual({ success: true });
    expect(hookRuns(h, 'reference-transaction').length).toBeGreaterThan(beforePull);
    const after = await m.getRemoteStatus(h.project);
    expect(after.behind).toBe(0);

    expect(hookRunsThatFoundAToken(h)).toEqual([]);
    expect(h.leaks(TOKEN)).toEqual([]);
    expect(existsSync(join(h.evidence, 'stolen-by-helper'))).toBe(false);
    expect(credentialDirsIn(h.tmp)).toEqual([]);
    // No remote URL, tokenized or not, is written into the reflog any more.
    expect(readFileSync(join(h.project, '.git', 'logs', 'HEAD'), 'utf8')).toContain('pull . refs/remotes/origin/main');
  }, 60_000);

  // S1. Commands .git/config can name, which git runs on its own: the
  // fsmonitor on every index read, clean/smudge filters and post-index-change
  // on an index refresh. A single `git pull` did the refresh BEFORE fetching,
  // i.e. while the token file existed (reproduced in review).
  test('config-named commands and index hooks never run while the token file exists', async () => {
    const h = await setupProject('config-exec');
    const probe = (name: string, body: string) => {
      const path = join(h.evidence, `probe-${name}`);
      writeFileSync(path, [
        '#!/bin/sh',
        `n=0; for f in "${h.tmp}"/*/token; do [ -f "$f" ] && n=1; done`,
        `echo "${name} $n" >> "${h.evidence}/probes"`,
        body,
      ].join('\n'), { mode: 0o755 });
      return path;
    };
    writeFileSync(join(h.project, '.gitattributes'), '*.txt filter=x\n');
    writeFileSync(join(h.project, 'a.txt'), 'one\n');
    await setup([REAL_GIT!, 'add', '.'], h.project, h.gitEnv);
    await setup([REAL_GIT!, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tracked'], h.project, h.gitEnv);
    await setup([REAL_GIT!, 'config', 'core.fsmonitor', probe('fsmonitor', 'exit 1')], h.project, h.gitEnv);
    await setup([REAL_GIT!, 'config', 'filter.x.clean', probe('clean', 'cat')], h.project, h.gitEnv);
    await setup([REAL_GIT!, 'config', 'filter.x.smudge', probe('smudge', 'cat')], h.project, h.gitEnv);
    // A rebase pull checks the work tree is clean first: the index refresh.
    await setup([REAL_GIT!, 'config', 'pull.rebase', 'true'], h.project, h.gitEnv);
    writeFileSync(join(h.project, '.git', 'hooks', 'post-index-change'), readFileSync(probe('post-index-change', 'exit 0')), { mode: 0o755 });

    // CONTROL: with a token file present, the probes see it.
    const planted = join(h.tmp, `${CREDENTIAL_DIR_PREFIX}control`);
    mkdirSync(planted);
    writeFileSync(join(planted, 'token'), TOKEN);
    await setup([REAL_GIT!, 'status', '--porcelain'], h.project, h.gitEnv);
    expect(readFileSync(join(h.evidence, 'probes'), 'utf8')).toContain('fsmonitor 1');
    rmSync(planted, { recursive: true });
    writeFileSync(join(h.evidence, 'probes'), '');

    useHarnessEnv(h);
    const m = manager();
    expect((await m.push(h.project)).success).toBe(true);
    await upstreamCommit(h);
    // Stat-dirty, content-clean: forces the refresh to run the clean filter.
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(h.project, 'a.txt'), later, later);
    expect((await m.getRemoteStatus(h.project)).behind).toBe(1);
    expect(await m.pull(h.project)).toEqual({ success: true });

    const runs = readFileSync(join(h.evidence, 'probes'), 'utf8').trim().split('\n').filter(Boolean);
    // They did run (after the token was gone), so this is not vacuous...
    expect(runs.some(r => r.startsWith('fsmonitor '))).toBe(true);
    expect(runs.some(r => r.startsWith('clean '))).toBe(true);
    // ...and none of them ever saw the token file.
    expect(runs.filter(r => r.endsWith(' 1'))).toEqual([]);
    expect(h.leaks(TOKEN)).toEqual([]);
  }, 60_000);

  // On git < 2.46 this is the documented gap: see gitHardeningArgs.
  test.skipIf(!GIT_HAS_PROACTIVE_AUTH)('a public repo, which never challenges, still consumes the token before any hook runs', async () => {
    const h = await setupProject('public-fetch');
    useHarnessEnv(h);
    const m = manager();
    expect((await m.push(h.project)).success).toBe(true);
    await upstreamCommit(h);

    const before = server.requests.length;
    const hooksBefore = hookRuns(h, 'reference-transaction').length;
    const status = await m.getRemoteStatus(h.project);
    expect(status.behind).toBe(1);

    // The server would have answered anonymously, yet the helper was asked
    // up front, so the file was gone before reference-transaction ran.
    const seen = server.requests.slice(before);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(r => r.auth !== 'ok').length).toBe(0);
    expect(hookRuns(h, 'reference-transaction').length).toBeGreaterThan(hooksBefore);
    expect(hookRunsThatFoundAToken(h)).toEqual([]);
    expect(h.leaks(TOKEN)).toEqual([]);
  }, 60_000);

  test('a local-path pushurl ahead of origin means no token at all, so pre-push has nothing to find', async () => {
    const h = await setupProject('pushurl');
    const decoy = join(tempRoot('decoy'), 'decoy.git');
    await setup([REAL_GIT!, 'init', '-q', '--bare', decoy], root, h.gitEnv);
    await setup([REAL_GIT!, 'config', '--add', 'remote.origin.pushurl', decoy], h.project, h.gitEnv);
    await setup([REAL_GIT!, 'config', '--add', 'remote.origin.pushurl', `${server.base}/pushurl.git`], h.project, h.gitEnv);
    useHarnessEnv(h);

    const before = server.requests.length;
    const result = await manager().push(h.project);
    // Plain git: the decoy gets the push, GitHub refuses the anonymous one.
    expect(result.success).toBe(false);
    expect(result.error).toContain('so the GitHub token was not used');
    expect(hookRuns(h, 'pre-push').length).toBeGreaterThan(0);
    expect(server.requests.slice(before).filter(r => r.auth !== 'none').length).toBe(0);
    expect(hookRunsThatFoundAToken(h)).toEqual([]);
    expect(h.leaks(TOKEN)).toEqual([]);
    expect(credentialDirsIn(h.tmp)).toEqual([]);
  }, 30_000);

  // The backstop behind the URL check, should the config change between the
  // check and the command: the pins must beat a project that allows more.
  test('the transport pins beat a project-level protocol.file.allow=always', async () => {
    const h = await setupProject('pins');
    const decoy = join(tempRoot('decoy'), 'decoy.git');
    await setup([REAL_GIT!, 'init', '-q', '--bare', decoy], root, h.gitEnv);
    await setup([REAL_GIT!, 'config', 'protocol.file.allow', 'always'], h.project, h.gitEnv);
    await setup([REAL_GIT!, 'config', 'protocol.allow', 'always'], h.project, h.gitEnv);
    const target = { protocol: 'http', host: server.host };
    const pinned = await run(
      [REAL_GIT!, ...credentialHelperArgs(join(h.tmp, 'absent'), target), ...gitHardeningArgs(target), 'push', decoy, 'main'],
      h.project, undefined, h.gitEnv,
    );
    expect(pinned.exitCode).not.toBe(0);
    expect(pinned.stderr).toContain("transport 'file' not allowed");
    expect(readdirSync(join(decoy, 'refs', 'heads')).length).toBe(0);
  }, 30_000);

  test('an insteadOf redirect to another host gets no credential at all', async () => {
    const h = await setupProject('redirect');
    const elsewhere = startGitServer(bare, REAL_GIT!);
    try {
      await setup([REAL_GIT!, 'config', `url.${elsewhere.base}/.insteadOf`, `${server.base}/`], h.project, h.gitEnv);
      useHarnessEnv(h);

      const result = await manager().push(h.project);
      expect(result.success).toBe(false);
      // The redirect was followed (so the check below is not vacuous), and
      // nothing that arrived there carried a credential.
      expect(elsewhere.requests.length).toBeGreaterThan(0);
      expect(elsewhere.requests.filter(r => r.auth !== 'none').length).toBe(0);
      expect(hookRunsThatFoundAToken(h)).toEqual([]);
      expect(h.leaks(TOKEN)).toEqual([]);
      expect(credentialDirsIn(h.tmp)).toEqual([]);
    } finally {
      elsewhere.server.stop(true);
    }
  }, 30_000);

  test('status scrubs an old token URL even when no token is configured', async () => {
    const h = await setupProject('scrub');
    await plantStaleTokenUrl(h, 'main');
    useHarnessEnv(h);
    setEnv('JARVIS_GITHUB_TOKEN', undefined);
    // Point the keychain at an empty dir so no real token can be picked up.
    setEnv('JARVIS_SECRETS_DIR', tempRoot('no-secrets'));

    const before = server.requests.length;
    await manager().getRemoteStatus(h.project);
    expect(server.requests.length).toBe(before);
    expect(readFileSync(join(h.project, '.git', 'config'), 'utf8')).not.toContain(OLD_TOKEN);
  }, 30_000);

  // S5: `remote remove` keeps branch.*.remote values that are URLs, not names.
  test('removeRemote, and status with no remote left, still scrub an old token URL', async () => {
    const h = await setupProject('scrub-removed');
    useHarnessEnv(h);

    await plantStaleTokenUrl(h, 'main');
    await manager().removeRemote(h.project);
    expect(readFileSync(join(h.project, '.git', 'config'), 'utf8')).not.toContain(OLD_TOKEN);

    // A project whose remote was removed before this fix shipped.
    await plantStaleTokenUrl(h, 'other');
    const status = await manager().getRemoteStatus(h.project);
    expect(status.hasRemote).toBe(false);
    expect(readFileSync(join(h.project, '.git', 'config'), 'utf8')).not.toContain(OLD_TOKEN);
  }, 30_000);

  test('the credential dir is 0700 and the token file 0600 while git runs', async () => {
    const h = await setupProject('modes');
    // The dir and file exist before git is spawned, so the PATH wrapper can
    // record their modes just before it execs the real git.
    writeFileSync(join(h.project, '..', 'bin', 'git'), [
      '#!/bin/sh',
      `for d in "${h.tmp}"/${CREDENTIAL_DIR_PREFIX}*; do [ -d "$d" ] && stat -c "%a %n" "$d" "$d"/token >> "${h.evidence}/modes"; done`,
      `exec "${REAL_GIT}" "$@"`,
    ].join('\n'), { mode: 0o755 });
    useHarnessEnv(h);

    expect((await manager().push(h.project)).success).toBe(true);
    const modes = readFileSync(join(h.evidence, 'modes'), 'utf8').trim().split('\n').map(l => l.split(' ')[0]);
    expect(modes).toEqual(['700', '600']);
    expect(credentialDirsIn(h.tmp)).toEqual([]);
  }, 30_000);
});
