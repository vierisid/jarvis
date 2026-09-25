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

  test.each([...OPTIONS, ...MALFORMED])('every branch call refuses %j', async (name) => {
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
});
