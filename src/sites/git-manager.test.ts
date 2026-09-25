/**
 * GitManager runs git in model-written project trees on every listing, chat
 * turn and dashboard action (#516). These plant each code-running config key
 * straight into .git/config -- as a project written before the site file tools
 * refused .git would have it -- and check that the daemon's git calls start
 * none of them. Real git, real temp repos.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizedEnv } from '../util/subprocess-env.ts';
import { isolateGitHome } from './fixtures/git-home.ts';
import { GitManager } from './git-manager.ts';

let root: string;
let repo: string;
let marker: string;
const git = new GitManager();

// Git reads the developer's ~/.gitconfig through the allowlisted HOME, and a
// global commit.gpgSign or gpg.format would change what these tests measure.
let restoreHome = () => {};
beforeAll(() => { restoreHome = isolateGitHome(); });
afterAll(() => restoreHome());

/** A shell command that proves it ran by creating the marker file. */
const touch = () => `touch '${marker}'`;

function plant(config: string): void {
  appendFileSync(join(repo, '.git', 'config'), config);
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-git-manager-'));
  repo = join(root, 'repo');
  marker = join(root, 'RAN');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.txt'), 'one\n');
  await git.init(repo, { name: 'Test', email: 'test@example.invalid', global: false });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('planted config does not run code through the daemon', () => {
  test('core.fsmonitor does not run on status', async () => {
    plant(`[core]\n\tfsmonitor = "${touch()}; false"\n`);
    writeFileSync(join(repo, 'src', 'a.txt'), 'two\n');
    expect(await git.isDirty(repo)).toBe(true);
    await git.getCurrentBranch(repo);
    expect(existsSync(marker)).toBe(false);
  });

  test('core.hooksPath hooks do not run on the auto-commit', async () => {
    mkdirSync(join(repo, 'hooks'));
    executable(join(repo, 'hooks', 'pre-commit'), touch());
    executable(join(repo, 'hooks', 'post-commit'), touch());
    plant('[core]\n\thooksPath = hooks\n');
    writeFileSync(join(repo, 'src', 'a.txt'), 'two\n');
    expect((await git.autoCommit(repo, 'edit'))?.message).toBe('edit');
    expect(existsSync(marker)).toBe(false);
  });

  test('.git/hooks do not run on the auto-commit or a checkout', async () => {
    executable(join(repo, '.git', 'hooks', 'pre-commit'), touch());
    executable(join(repo, '.git', 'hooks', 'post-checkout'), touch());
    writeFileSync(join(repo, 'src', 'a.txt'), 'two\n');
    await git.autoCommit(repo, 'edit');
    await git.createBranch(repo, 'feature');
    expect(existsSync(marker)).toBe(false);
  });

  test('diff.external does not run on getDiff', async () => {
    plant(`[diff]\n\texternal = "${join(root, 'ext.sh')}"\n`);
    executable(join(root, 'ext.sh'), touch());
    writeFileSync(join(repo, 'src', 'a.txt'), 'two\n');
    expect(await git.getDiff(repo)).toContain('+two');
    expect(existsSync(marker)).toBe(false);
  });

  test('a textconv driver does not run on getDiff', async () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt diff=conv\n');
    plant(`[diff "conv"]\n\ttextconv = "${join(root, 'conv.sh')}"\n`);
    executable(join(root, 'conv.sh'), `${touch()}; cat "$1"`);
    writeFileSync(join(repo, 'src', 'a.txt'), 'two\n');
    await git.getDiff(repo);
    expect(existsSync(marker)).toBe(false);
  });

  // getDiff makes two calls, `diff --cached` and `diff`; the tests above only
  // reach the second. Stage the change so the first one has something to run
  // a driver on, and leave the worktree clean so the second has nothing.
  test.each([
    ['diff.external', () => plant(`[diff]\n\texternal = "${join(root, 'drv.sh')}"\n`)],
    ['a textconv driver', () => {
      writeFileSync(join(repo, '.gitattributes'), '*.txt diff=conv\n');
      plant(`[diff "conv"]\n\ttextconv = "${join(root, 'drv.sh')}"\n`);
    }],
  ])('%s does not run on the staged half of getDiff', async (_label, setup) => {
    writeFileSync(join(repo, 'src', 'a.txt'), 'staged\n');
    const staged = Bun.spawnSync(['git', 'add', '-A'], { cwd: repo, stdout: 'pipe', stderr: 'pipe', env: sanitizedEnv() });
    expect(staged.exitCode).toBe(0);
    setup();
    executable(join(root, 'drv.sh'), `${touch()}; cat "$1"`);
    expect(await git.getDiff(repo)).toContain('+staged');
    expect(existsSync(marker)).toBe(false);
  });

  test('log.showSignature does not start gpg.program on getLog', async () => {
    // Only a signed commit makes git verify, so make one (as a pulled GitHub
    // web commit would be) with a stand-in signer.
    const signer = join(root, 'sign.sh');
    executable(signer, [
      'cat >/dev/null',
      "echo '[GNUPG:] SIG_CREATED D 1 8 00 0 X' >&2",
      "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'",
    ].join('\n'));
    // Sanitized env, not inherited: under the pre-commit hook the test process
    // carries the outer commit's GIT_DIR/GIT_INDEX_FILE, and an inherited
    // `git commit` here lands in THAT repository instead of the temp one.
    const signed = Bun.spawnSync(['git', '-c', 'gpg.format=openpgp', '-c', `gpg.program=${signer}`, 'commit', '--allow-empty', '-S', '-m', 'signed'], {
      cwd: repo, stdout: 'pipe', stderr: 'pipe', env: sanitizedEnv(),
    });
    expect(signed.exitCode).toBe(0);

    plant(`[log]\n\tshowSignature = true\n[gpg]\n\tprogram = "${join(root, 'gpg.sh')}"\n`);
    executable(join(root, 'gpg.sh'), touch());
    expect((await git.getLog(repo, 1)).length).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });
});

/**
 * Config-defined hooks (`hook.<name>.command`) arrived in git 2.54. The
 * real-git tests below need a git that runs them for their plain-git control
 * to mean anything, so they are skipped on older git rather than left to fail
 * on a stock distro git; the fake-git tests run everywhere.
 */
const GIT_HAS_CONFIG_HOOKS = (() => {
  const real = Bun.which('git');
  if (!real) return false;
  const out = Bun.spawnSync([real, '--version']).stdout.toString();
  const [major = 0, minor = 0] = (out.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  return major > 2 || (major === 2 && minor >= 54);
})();

describe('config-defined hooks', () => {
  /** A hook defined in config, not in a hooks dir: `hooksPath=/dev/null` alone misses it. */
  function plantConfigHook(event: string): void {
    plant(`[hook "x"]\n\tcommand = "${touch()}"\n\tevent = ${event}\n`);
  }

  /** The user's own git in the same repo: no pins. */
  function plainGit(...args: string[]): number {
    return Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe', env: sanitizedEnv() }).exitCode;
  }

  test.skipIf(!GIT_HAS_CONFIG_HOOKS)('a pre-commit config hook does not run on the auto-commit', async () => {
    plantConfigHook('pre-commit');
    writeFileSync(join(repo, 'src', 'a.txt'), 'two\n');
    expect((await git.autoCommit(repo, 'edit'))?.message).toBe('edit');
    expect(existsSync(marker)).toBe(false);

    // Control: the hook is real, and plain git runs it.
    writeFileSync(join(repo, 'src', 'a.txt'), 'three\n');
    expect(plainGit('commit', '-am', 'by hand')).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  test.skipIf(!GIT_HAS_CONFIG_HOOKS)('a post-checkout config hook does not run on createBranch or switchBranch', async () => {
    plantConfigHook('post-checkout');
    const base = await git.getCurrentBranch(repo);
    await git.createBranch(repo, 'feature');
    await git.switchBranch(repo, base);
    expect(existsSync(marker)).toBe(false);

    expect(plainGit('switch', 'feature')).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  // A stand-in git: `version` is the body of its `--version` case arm,
  // `lookup` of its hook-lookup arm; status prints " M x"; every argv, and the
  // cwd of each `--version` call, is logged.
  async function onFakeGit(
    version: string,
    lookup: string,
    action: (gm: GitManager) => Promise<unknown>,
  ): Promise<string[]> {
    const fakeBin = join(root, 'fake-bin');
    const log = join(root, 'fake-git.log');
    mkdirSync(fakeBin);
    executable(join(fakeBin, 'git'), [
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$*" in',
      `  *--version*) printf 'cwd=%s\\n' "$PWD" >> '${log}'; ${version} ;;`,
      `  *'^hook'*) ${lookup} ;;`,
      "  *'status --porcelain'*) echo ' M x' ;;",
      'esac',
    ].join('\n'));
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${savedPath ?? ''}`;
    try {
      await action(new GitManager());
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    return readFileSync(log, 'utf-8').split('\n');
  }
  const v254 = 'echo "git version 2.54.0"';
  const isLookup = (l: string) => l.includes('--get-regexp');

  // git 2.54 has config hooks but no event-level switch, so there the event
  // pins do nothing and the manager must name each hook.
  test('on git 2.54 each configured hook is also pinned off by name', async () => {
    const listing = "printf 'hook.lint.command\\n/x\\0hook..event\\npre-commit\\0'";
    const calls = await onFakeGit(v254, listing, (gm) => gm.isDirty(repo));
    const status = calls.find((l) => l.includes('status --porcelain'))!;
    expect(status).toContain('hook.lint.enabled=false');
    // The empty-named hook (`[hook ""]`) is runnable too.
    expect(status).toContain('-c hook..enabled=false');
  });

  test('on git 2.54, a lookup that finds no hooks (exit 1) lets the call run', async () => {
    // Every call on 2.54 depends on exit 1 being read as "none", which needs
    // the exit code on GitManager's errors.
    let dirty: boolean | undefined;
    const calls = await onFakeGit(v254, 'exit 1', async (gm) => { dirty = await gm.isDirty(repo); });
    expect(dirty).toBe(true);
    expect(calls.some((l) => l.includes('status --porcelain'))).toBe(true);
  });

  test('on git 2.54, a lookup that fails otherwise stops the call', async () => {
    // 128 is what a broken config gives: not "no hooks".
    let error: unknown;
    const calls = await onFakeGit(v254, 'exit 128', (gm) => gm.isDirty(repo).catch((e) => { error = e; }));
    expect(String(error)).toContain('git config failed');
    expect(calls.some((l) => l.includes('status --porcelain'))).toBe(false);
  });

  test.each([
    ['2.55, whose event pins cover config hooks', 'echo "git version 2.55.0"'],
    ['2.53, which has no config hooks', 'echo "git version 2.53.1"'],
  ])('on git %s, no lookup is made', async (_label, version) => {
    const calls = await onFakeGit(version, 'exit 1', async (gm) => {
      await gm.isDirty(repo);
      await gm.isDirty(repo);
    });
    expect(calls.filter(isLookup)).toEqual([]);
    // The version is read once per manager, from `/`, not from the project.
    expect(calls.filter((l) => l.startsWith('cwd='))).toEqual(['cwd=/']);
  });

  test.each([
    ['a release candidate', 'echo "git version 2.55.0.rc1"'],
    ['an unparseable version', 'echo "git version unknown"'],
    ['a failed version read', 'exit 2'],
  ])('on %s, the lookup is made and the call still runs', async (_label, version) => {
    let dirty: boolean | undefined;
    const calls = await onFakeGit(version, 'exit 1', async (gm) => { dirty = await gm.isDirty(repo); });
    expect(dirty).toBe(true);
    expect(calls.some(isLookup)).toBe(true);
  });

  test('a failed version read is retried on the next call, not remembered', async () => {
    const calls = await onFakeGit('exit 2', 'exit 1', async (gm) => {
      await gm.isDirty(repo);
      await gm.isDirty(repo);
    });
    expect(calls.filter((l) => l.startsWith('cwd='))).toEqual(['cwd=/', 'cwd=/']);
  });
});

describe('planted signing config', () => {
  test('commit.gpgSign does not start gpg.program on the auto-commit', async () => {
    plant(`[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = "${join(root, 'gpg.sh')}"\n`);
    executable(join(root, 'gpg.sh'), `${touch()}; exit 1`);
    writeFileSync(join(repo, 'src', 'a.txt'), 'two\n');
    expect((await git.autoCommit(repo, 'edit'))?.message).toBe('edit');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('branch names cannot become options (#520)', () => {
  const OPTIONS = ['--orphan=x', '--detach', '-f', '--force', '--exec=touch RAN', '-D', '-'];
  const MALFORMED = ['', 'a..b', 'HEAD', 'with space', 'trailing.lock', 'x~1'];
  // Accepted by `check-ref-format --branch`, but not a plain branch name:
  // rewritten by it (`@{-1}`), or a pseudo-ref, or a full ref path.
  const REWRITTEN = ['@{-1}', '@{upstream}', '@', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'head', 'refs/heads/main'];

  test.each([...OPTIONS, ...MALFORMED, ...REWRITTEN])('every branch call refuses %j', async (name) => {
    const head = await git.getCurrentBranch(repo);
    await expect(git.createBranch(repo, name)).rejects.toThrow('Invalid branch name');
    await expect(git.switchBranch(repo, name)).rejects.toThrow('Invalid branch name');
    await expect(git.merge(repo, name)).rejects.toThrow('Invalid branch name');
    await expect(git.rebase(repo, name)).rejects.toThrow('Invalid branch name');
    await expect(git.deleteBranch(repo, name)).rejects.toThrow('Invalid branch name');
    expect(await git.getCurrentBranch(repo)).toBe(head);
    expect((await git.getBranches(repo)).map((b) => b.name)).toEqual([head]);
    expect(existsSync(join(repo, 'RAN'))).toBe(false);
  });

  test('switchBranch never checks out a path of the same name', async () => {
    writeFileSync(join(repo, 'src', 'a.txt'), 'uncommitted\n');
    await expect(git.switchBranch(repo, 'src')).rejects.toThrow();
    expect(readFileSync(join(repo, 'src', 'a.txt'), 'utf-8')).toBe('uncommitted\n');
  });

  test('a shorthand check-ref-format would expand is refused, not expanded', async () => {
    // With a previous branch, `check-ref-format --branch @{-1}` succeeds and
    // prints that branch's name; only comparing its output to the input
    // catches it.
    const base = await git.getCurrentBranch(repo);
    await git.createBranch(repo, 'other');
    await git.switchBranch(repo, base);
    for (const call of [
      () => git.switchBranch(repo, '@{-1}'),
      () => git.merge(repo, '@{-1}'),
      () => git.deleteBranch(repo, '@{-1}'),
    ]) {
      await expect(call()).rejects.toThrow('Invalid branch name');
    }
    expect(await git.getCurrentBranch(repo)).toBe(base);
    expect((await git.getBranches(repo)).map((b) => b.name).sort()).toEqual([base, 'other'].sort());
  });

  test('the leading-dash check holds on its own, before git is ever asked', async () => {
    // A stand-in git that approves every name check-ref-format is given (it
    // echoes its last argument) and logs every call. Real git rejects a
    // leading dash too, so only a git that would NOT is a test of the check
    // in front of it.
    const fakeBin = join(root, 'fake-bin');
    const log = join(root, 'fake-git.log');
    mkdirSync(fakeBin);
    executable(join(fakeBin, 'git'), `echo "$*" >> '${log}'\nfor a; do last=$a; done\nprintf '%s\\n' "$last"`);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${savedPath ?? ''}`;
    try {
      for (const name of ['--orphan=x', '--detach', '-f']) {
        await expect(git.switchBranch(repo, name)).rejects.toThrow('Invalid branch name');
        await expect(git.createBranch(repo, name)).rejects.toThrow('Invalid branch name');
      }
      // Positive control: the stand-in is really on PATH and would approve.
      await git.switchBranch(repo, 'feature');
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    const calls = readFileSync(log, 'utf-8');
    expect(calls).not.toContain('--orphan=x');
    expect(calls).not.toContain('--detach');
    expect(calls).not.toMatch(/ -f(\s|$)/);
    expect(calls).toContain('switch -- feature');
  });

  test('ordinary branch operations still work', async () => {
    const base = await git.getCurrentBranch(repo);
    await git.createBranch(repo, 'feature/x');
    expect(await git.getCurrentBranch(repo)).toBe('feature/x');
    writeFileSync(join(repo, 'src', 'b.txt'), 'b\n');
    await git.autoCommit(repo, 'add b');
    await git.switchBranch(repo, base);
    expect(await git.getCurrentBranch(repo)).toBe(base);
    expect((await git.merge(repo, 'feature/x')).success).toBe(true);
    await git.deleteBranch(repo, 'feature/x');
    expect((await git.getBranches(repo)).map((b) => b.name)).toEqual([base]);
  });

  // Names that merely resemble the refused ones.
  test.each(['page_head', 'my_head', 'headline', 'v1.0', 'refsx/y', 'at@home'])('%j is an ordinary branch', async (name) => {
    const base = await git.getCurrentBranch(repo);
    await git.createBranch(repo, name);
    expect(await git.getCurrentBranch(repo)).toBe(name);
    await git.switchBranch(repo, base);
    await git.deleteBranch(repo, name);
    expect((await git.getBranches(repo)).map((b) => b.name)).toEqual([base]);
  });
});
