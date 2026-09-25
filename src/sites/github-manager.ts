/**
 * Site Builder — GitHub Manager
 *
 * Handles GitHub integration: token management (via encrypted keychain),
 * GitHub REST API calls (create/list repos, validate token), and git
 * remote operations (push, pull, fetch, ahead/behind status).
 */

import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getSecret, setSecret, deleteSecret, hasSecret } from '../vault/keychain.ts';
import type { GitRemoteStatus, GitHubRepoOptions } from './types.ts';
import { sanitizedEnv } from '../util/subprocess-env.ts';

const TOKEN_KEY = 'github.personal_access_token';
const API_BASE = 'https://api.github.com';

/**
 * The only place git may send the PAT. The token is only written at all when
 * every fetch and push URL of origin (after insteadOf) is on this target, and
 * the credential helper answers nothing for any other protocol/host. That
 * stops a planted `url.<x>.insteadOf` or `remote.origin.pushurl` from simply
 * NAMING another host. It does not stop a planted .git/config from redirecting
 * the connection underneath a correct URL -- see "WHAT THIS DOES NOT PROMISE"
 * on credentialHelperArgs. Nor does it pin owner/repo: another github.com repo
 * the token can reach is accepted.
 *
 * The compare is literal: `https://github.com:443/...` or `GitHub.com` is
 * treated as "not GitHub" and pushed without the token. The app only ever sets
 * the API's `clone_url`, which is neither.
 */
export type CredentialTarget = { protocol: string; host: string };
const GITHUB_CREDENTIAL_TARGET: CredentialTarget = { protocol: 'https', host: 'github.com' };

/** Prefix of the per-call temp dir holding the token file. */
export const CREDENTIAL_DIR_PREFIX = 'jarvis-gh-cred-';
/**
 * A credential dir older than this was orphaned by a killed daemon. Must stay
 * above GIT_NETWORK_TIMEOUT_MS, or the sweep could pull the file out from
 * under a push that is still legitimately running. Age is judged by mtime,
 * i.e. wall clock: a clock jump forward of more than the margin can sweep a
 * live dir. Accepted, because that fails closed (the push fails to
 * authenticate) and leaks nothing.
 */
const STALE_CREDENTIAL_DIR_MS = 15 * 60_000;

/**
 * Upper bound on one authenticated git command. Generous, because a first
 * push of a large site over a slow link is legitimately slow; its job is to
 * make sure a stalled network or a hook that never returns cannot keep the
 * token file alive indefinitely.
 */
const GIT_NETWORK_TIMEOUT_MS = 10 * 60_000;

/**
 * After a timeout kill, how long to keep reading git's pipes before giving up
 * on whatever escaped the process group and still holds them.
 */
const PIPE_GRACE_MS = 2_000;

/**
 * Collect a pipe as text, with a way to stop waiting. `new Response(stream)`
 * locks the stream with no way to abandon the read, so a holder that never
 * closes it would pin the call.
 */
function readPipe(stream: ReadableStream<Uint8Array>): { text: Promise<string>; cancel: () => void } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const text = (async () => {
    let result = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      result += decoder.decode(value, { stream: true });
    }
  })();
  return { text, cancel: () => { reader.cancel().catch(() => { /* already closed */ }); } };
}

/**
 * Transports pinned to `never` while git holds the credential helper, except
 * the target's own. Not exhaustive and cannot be: a remote helper
 * (`foo::<url>`, run as `git-remote-foo` from PATH) is a transport too, and a
 * project-level `protocol.foo.allow=always` beats our `protocol.allow=never`.
 * The guard for those is originCredentialUrls, which authedGit runs
 * before writing the token file (a `foo::` URL or `remote.origin.vcs` fails
 * it). Only a config changed between that check and the command gets past
 * it to a custom helper; this list is the backstop for the built-in
 * transports that run code (file hooks, ssh commands, ext::, fd::).
 */
const KNOWN_PROTOCOLS = ['file', 'git', 'ext', 'fd', 'ssh', 'http', 'https'] as const;

/**
 * `-c` pins on EVERY git command this class runs, authenticated or not. Each
 * names something a model-written project tree could otherwise make git run:
 *   - `safe.bareRepository=explicit`: a bare repository planted at the
 *     project root (HEAD, objects/, refs/, config) is otherwise discovered
 *     implicitly, and its config runs code on a plain `git status` (#516).
 *   - `core.fsmonitor=false`: the fsmonitor command runs on every index read.
 *   - `commit.gpgSign=false`, `log.showSignature=false`: pull's integrate step
 *     can create merge or rebase commits, and `gpg.program` is configurable
 *     by the project.
 * Mirrors PROJECT_GIT_PINS in git-manager.ts on the #516 branch; kept inline
 * until that lands. Hooks are deliberately NOT disabled here: whether a
 * daemon push should run the project's pre-push hook is an open maintainer
 * decision. If it goes the other way, add `'-c', 'core.hooksPath=/dev/null'`
 * to this list -- one line.
 */
const PROJECT_GIT_PINS: readonly string[] = [
  '-c', 'safe.bareRepository=explicit',
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'log.showSignature=false',
];

/**
 * git/ssh stderr that means "could not authenticate or reach the repo as
 * this user". `Permission denied` is anchored to ssh's form, so a local
 * "unable to create file: Permission denied" is not mistaken for one.
 */
const AUTH_FAILURE = new RegExp([
  'Authentication failed', 'could not read (Username|Password)', 'terminal prompts disabled',
  'Permission denied \\(publickey', 'Host key verification failed', 'Could not read from remote repository',
  'Repository not found', 'denied to ', 'returned error: 40[13]', '403 Forbidden', '401 Unauthorized',
].join('|'), 'i');

/** How pull() integrates what its authenticated fetch brought in. */
type IntegrationPlan =
  | { kind: 'pull' }
  | { kind: 'rebase'; rebaseMerges: boolean; forkPoint: string | null };

/**
 * Printable ASCII, no space. Anything else could not be a PAT, and a newline
 * would inject extra lines into the credential protocol.
 */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/**
 * A branch.<name>.remote holding an http(s) URL with userinfo. The pre-#511
 * `git push -u https://<token>@github.com/...` persisted exactly this into
 * .git/config, inside the model-readable project tree.
 */
const PERSISTED_CREDENTIAL_URL = /^https?:\/\/[^/@\s]+@/i;

/**
 * A branch name that git will read as a plain `<branch>` refspec. The current
 * branch comes from .git/HEAD, which a model-written tree controls:
 *   - a leading `-` would be an option (`--receive-pack=<cmd>`);
 *   - a leading `+` is a valid refname but makes the refspec a FORCE push;
 *   - a `:` would make it `<src>:<dst>`, pushing to a ref the caller never
 *     named (refnames cannot contain one, but .git/HEAD is not validated).
 */
function isSafeBranchArg(branch: string): boolean {
  return branch.length > 0 && !/^[-+]/.test(branch) && !branch.includes(':');
}

/**
 * The path of an origin URL we are willing to pin config for: plain
 * `owner/repo.git`-style segments. The exact-URL `-c http.<url>.* =` pin
 * depends on the key being byte for byte the URL git matches, and two things
 * break that (reproduced in review): an `=` (git splits `-c` at the FIRST
 * one, turning the pin into a different, useless key) and `.`/`..` segments
 * or other characters git normalises before matching. GitHub owner and repo
 * names are `[A-Za-z0-9_.-]`, so this refuses nothing real.
 */
function isPlainRepoPath(path: string): boolean {
  const segments = path.split('/');
  if (segments[segments.length - 1] === '') segments.pop(); // one trailing slash
  return segments.length > 0
    && segments.every(s => /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..');
}

/** Single-quote for POSIX sh. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `git -c` arguments that make git obtain the PAT from `tokenFile`, and from
 * nowhere else.
 *
 * Why this shape (#511): the token used to travel as `https://<token>@github.com/...`
 * in git's argv, where `ps` shows it, git hands it to a `pre-push` hook as $2,
 * and `push -u` wrote it into .git/config. Here argv carries only the file
 * PATH. The environment is no alternative: every variable git sees is
 * inherited by the project's hooks, so a GIT_ASKPASS-style token variable
 * would be strictly worse than argv.
 *
 * - The empty `credential.helper=` first resets the helper list, so helpers
 *   from system, global or the (model-writable) local config never run. Git
 *   also calls `store` on every configured helper after a successful auth,
 *   which would otherwise hand the PAT to e.g. `credential.helper=store`.
 * - The helper answers only `get` and only for `target`, and deletes the file
 *   on the FIRST `get`, whatever it was for: a request for any other host
 *   burns the token rather than leaving it for later. `store`/`erase` carry
 *   the password on stdin; the helper drains and discards it.
 * - The token goes file -> `cat` -> stdout. It is never held in a shell
 *   variable or passed as an argument, so it cannot reach an argv even under
 *   a shell whose `printf` is not a builtin.
 * - Command-line `-c` values reach child git processes through
 *   GIT_CONFIG_PARAMETERS, and so reach hooks. That is why the token itself is
 *   never in here: a hook sees the file PATH.
 *
 * Fails closed, by design, wherever a second `get` would be needed: a proxy
 * that answers 407 (git asks for proxy credentials first, which burns the
 * file), a git-lfs pre-push hook calling `git credential fill`, and proxy
 * credentials that used to come from a global helper the reset now skips.
 *
 * WHAT THIS DOES NOT PROMISE. It keeps the token out of argv, out of hook
 * arguments, and out of files in the project tree. It does not protect the
 * token from a hostile .git/config, which the site file tools can write
 * (#516):
 *   - Same-uid code -- a hook, or a command .git/config names -- can read the
 *     path above before git asks for it, or simply read the keychain key in
 *     the data dir (see the header of src/util/subprocess-env.ts).
 *     gitHardeningArgs narrows that window; it cannot close it while the
 *     project's own hooks run.
 *   - The connection can be redirected underneath a correct github.com URL:
 *     a local `http.proxy` plus `http.sslVerify=false` (or `http.sslCAInfo`
 *     pointing at a CA in the tree, or `http.curloptResolve`) delivers the
 *     Basic auth header, token included, to a listener of the attacker's
 *     choosing. Reproduced in review. Command-line pins do not help: these
 *     keys are URL-matchable, and a project-level `http.<url>.<key>` beats a
 *     command-line `http.<key>` because the more specific URL match wins. So
 *     they are deliberately not pinned here; the `http.proxy=` "pin" would
 *     also disable HTTPS_PROXY on the proxied networks that need it.
 *   - Tokens already written into reflogs by the pre-#511 `pull <tokenUrl>`
 *     stay there (#517): rotate the token.
 */
export function credentialHelperArgs(tokenFile: string, target: CredentialTarget): string[] {
  const file = shellQuote(tokenFile);
  const helper = [
    '!f() {',
    ' test "$1" = get || { cat >/dev/null; exit 0; };',
    ' p=; h=;',
    ' while IFS= read -r l; do case "$l" in',
    ' protocol=*) p="${l#protocol=}";;',
    ' host=*) h="${l#host=}";;',
    ' "") break;;',
    ' esac; done;',
    ` test "$p" = ${shellQuote(target.protocol)} && test "$h" = ${shellQuote(target.host)} && test -s ${file}`,
    ` || { rm -f ${file}; exit 0; };`,
    ` printf 'username=x-access-token\\npassword='; cat ${file}; rm -f ${file}; printf '\\n';`,
    ' }; f',
  ].join('');
  return ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`];
}

/**
 * `git -c` arguments that make git ask for the token as early as possible and
 * stop the project's config from steering it anywhere else first. Each one
 * answers a way a model-written .git/config could make a hook run while the
 * token file still exists:
 *
 * - `http.<url>.proactiveAuth=basic`: ask the helper before the FIRST
 *   request instead of after a 401. Without it a public repo never challenges,
 *   so fetch/pull never consume the file and every hook of the operation runs
 *   with it in place. Pinned for the target host AND for each exact origin
 *   URL (`originUrls`): git picks the most specific matching URL, so a
 *   project-level `http.<exact origin URL>.proactiveAuth=none` beat the host
 *   pin (reproduced in review: reference-transaction read the token on a
 *   public repo). At equal specificity the command line wins, and nothing is
 *   more specific than the exact URL -- provided the pinned key IS the URL
 *   byte for byte, which is why originCredentialUrls only accepts plain
 *   repo paths (see isPlainRepoPath). git < 2.46 ignores the key and only
 *   asks after a 401, so on old git a PUBLIC repo's fetch/pull still runs
 *   every hook (reference-transaction, post-merge, ...) with the file in
 *   place. (The same exact-URL pin would not rescue `http.sslVerify` and its
 *   kin: redirecting the connection is #516, not something pinned here.)
 * - `protocol.*.allow`: the target's transport only. A `pushurl` to a local
 *   path, or to ssh with a planted `core.sshCommand`, runs code for that URL
 *   before git ever reaches GitHub and so before the file is consumed.
 *   authedGit already refuses to write the token unless every origin URL is
 *   on the target (originCredentialUrls); this is the backstop should the
 *   config change between that check and the command. The per-protocol keys
 *   are set explicitly because a project-level `protocol.file.allow=always`
 *   would beat `protocol.allow`. See KNOWN_PROTOCOLS for what this cannot
 *   enumerate.
 * - `core.fsmonitor=false`: git runs the fsmonitor command whenever it reads
 *   the index. Reproduced in review: `pull` read the index before fetching, so
 *   a planted fsmonitor read the token. (pull is now split so the index work
 *   happens after the token is gone, but push and fetch get the pin too.)
 * - no submodule recursion: each submodule is a second remote, and so a second
 *   `get` that the one-shot helper would refuse. Better predictable than a
 *   failure that depends on which submodule needed auth.
 *
 * Audited and NOT pinned, because git does not run them before the credential
 * `get` of an authenticated fetch or push (measured on git 2.55 with every one
 * planted, plus every hook via core.hooksPath): core.pager and core.editor /
 * sequence.editor (never started without a terminal), gpg.program, diff
 * textconv and merge drivers, filter clean/smudge/process, core.askPass (only
 * after the helper declines), core.alternateRefsCommand, and the hooks
 * themselves -- pre-push and reference-transaction run only after the `get`.
 * Filters and post-index-change DO run before the fetch inside a single
 * `git pull` (index refresh for a rebase pull), which is why pull() fetches
 * with the token and merges without it. Filter driver names are arbitrary, so
 * they could not be pinned here anyway.
 */
export function gitHardeningArgs(target: CredentialTarget, originUrls: readonly string[] = []): string[] {
  const args = ['-c', `http.${target.protocol}://${target.host}/.proactiveAuth=basic`];
  for (const url of new Set(originUrls)) args.push('-c', `http.${url}.proactiveAuth=basic`);
  args.push('-c', 'protocol.allow=never');
  for (const protocol of KNOWN_PROTOCOLS) {
    args.push('-c', `protocol.${protocol}.allow=${protocol === target.protocol ? 'always' : 'never'}`);
  }
  args.push(
    '-c', 'core.fsmonitor=false',
    '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'push.recurseSubmodules=no',
  );
  return args;
}

/**
 * Where the per-call credential dir goes: the per-user runtime dir (a 0700
 * tmpfs on systemd hosts, so the token never reaches a disk) when there is a
 * usable one, else the temp dir. "Usable" is checked, not assumed: after
 * `sudo -u`/`su` the variable often names another user's dir, and mkdtemp
 * there would fail every push with a raw EACCES.
 */
export function credentialRoot(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && runtime.startsWith('/')) {
    try {
      const st = lstatSync(runtime);
      const uid = process.getuid?.();
      if (st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0) return runtime;
    } catch { /* missing: fall through */ }
  }
  // Absolute, like the check above: a relative TMPDIR would otherwise put the
  // token file relative to whatever the cwd happens to be.
  return resolve(tmpdir());
}

/**
 * Remove credential dirs left behind by a daemon that was killed mid-push
 * (SIGKILL, OOM), whose `finally` never ran. Best effort: only our own real
 * directories are touched, never a symlink or another user's entry.
 */
export function sweepStaleCredentialDirs(root: string = credentialRoot(), now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!name.startsWith(CREDENTIAL_DIR_PREFIX)) continue;
    const full = join(root, name);
    try {
      const st = lstatSync(full);
      if (!st.isDirectory()) continue;
      if (uid !== undefined && st.uid !== uid) continue;
      if (now - st.mtimeMs < STALE_CREDENTIAL_DIR_MS) continue;
      rmSync(full, { recursive: true, force: true });
    } catch { /* gone already, or not ours to remove */ }
  }
}

export class GitHubManager {

  private readonly credentialTarget: CredentialTarget;
  private readonly networkTimeoutMs: number;

  /**
   * Both options are test seams: the integration test pushes over HTTP to a
   * loopback `git http-backend`, and the timeout test cannot wait ten minutes.
   * Production always uses https://github.com and GIT_NETWORK_TIMEOUT_MS.
   */
  constructor(options: { credentialTarget?: CredentialTarget; networkTimeoutMs?: number } = {}) {
    this.credentialTarget = options.credentialTarget ?? GITHUB_CREDENTIAL_TARGET;
    this.networkTimeoutMs = options.networkTimeoutMs ?? GIT_NETWORK_TIMEOUT_MS;
    // A daemon killed mid-push left its dir behind; don't wait for the next
    // push to notice.
    sweepStaleCredentialDirs();
  }

  // ── Token Management ──

  getToken(): string | null {
    return process.env.JARVIS_GITHUB_TOKEN ?? getSecret(TOKEN_KEY);
  }

  setToken(token: string): void {
    setSecret(TOKEN_KEY, token);
  }

  deleteToken(): void {
    deleteSecret(TOKEN_KEY);
  }

  hasToken(): boolean {
    return !!process.env.JARVIS_GITHUB_TOKEN || hasSecret(TOKEN_KEY);
  }

  /**
   * Validate the stored token against GitHub API.
   * Returns the authenticated username and granted scopes.
   */
  async validateToken(): Promise<{ valid: boolean; username: string | null; scopes: string[] }> {
    try {
      const res = await this.githubFetch('GET', '/user');
      const data = await res.json() as { login: string };
      const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map(s => s.trim()).filter(Boolean);
      return { valid: true, username: data.login, scopes };
    } catch {
      return { valid: false, username: null, scopes: [] };
    }
  }

  // ── Repository Operations ──

  /**
   * Create a new GitHub repository under the authenticated user.
   */
  async createRepo(options: GitHubRepoOptions): Promise<{
    owner: string;
    repo: string;
    cloneUrl: string;
    htmlUrl: string;
  }> {
    const res = await this.githubFetch('POST', '/user/repos', {
      name: options.name,
      description: options.description ?? '',
      private: options.private,
      auto_init: false,
    });
    const data = await res.json() as {
      owner: { login: string };
      name: string;
      clone_url: string;
      html_url: string;
    };
    return {
      owner: data.owner.login,
      repo: data.name,
      cloneUrl: data.clone_url,
      htmlUrl: data.html_url,
    };
  }

  /**
   * List the authenticated user's repositories (sorted by most recently updated).
   */
  async listUserRepos(page = 1, perPage = 30): Promise<Array<{
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    htmlUrl: string;
    cloneUrl: string;
  }>> {
    const res = await this.githubFetch('GET', `/user/repos?sort=updated&per_page=${perPage}&page=${page}`);
    const data = await res.json() as Array<{
      owner: { login: string };
      name: string;
      full_name: string;
      private: boolean;
      html_url: string;
      clone_url: string;
    }>;
    return data.map(r => ({
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
    }));
  }

  /**
   * Get info about a specific repo (used when connecting to an existing repo).
   */
  async getRepo(owner: string, repo: string): Promise<{
    owner: string;
    repo: string;
    cloneUrl: string;
    htmlUrl: string;
  }> {
    const res = await this.githubFetch('GET', `/repos/${owner}/${repo}`);
    const data = await res.json() as {
      owner: { login: string };
      name: string;
      clone_url: string;
      html_url: string;
    };
    return {
      owner: data.owner.login,
      repo: data.name,
      cloneUrl: data.clone_url,
      htmlUrl: data.html_url,
    };
  }

  // ── Git Remote Operations ──

  /**
   * Add or update the 'origin' remote for a project.
   */
  async addRemote(projectPath: string, remoteUrl: string): Promise<void> {
    const existing = await this.getRemoteUrl(projectPath);
    if (existing) {
      await this.git(projectPath, ['remote', 'set-url', 'origin', remoteUrl]);
    } else {
      await this.git(projectPath, ['remote', 'add', 'origin', remoteUrl]);
    }
  }

  /**
   * Remove the 'origin' remote.
   */
  async removeRemote(projectPath: string): Promise<void> {
    try {
      await this.git(projectPath, ['remote', 'remove', 'origin']);
    } catch { /* already gone */ }
    // `remote remove` only drops branch.*.remote entries that name the remote.
    // A token URL left by the pre-#511 push is not a name, so it would
    // survive, in a project that no longer runs any of the paths below.
    await this.scrubPersistedCredentialUrls(projectPath);
  }

  /**
   * Get the current origin remote URL, or null if not set.
   */
  async getRemoteUrl(projectPath: string): Promise<string | null> {
    try {
      const url = await this.git(projectPath, ['remote', 'get-url', 'origin']);
      return url.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Push to the origin remote. The token reaches git through a credential
   * helper, never through argv or the remote URL (see authedGit), and only
   * when origin is on GitHub over https (see remoteGit).
   */
  async push(projectPath: string, branch?: string, force = false): Promise<{ success: boolean; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: 'GitHub token not configured' };

    const remoteUrl = await this.getRemoteUrl(projectPath);
    if (!remoteUrl) return { success: false, error: 'No remote origin configured' };

    await this.scrubPersistedCredentialUrls(projectPath);
    const targetBranch = branch ?? await this.getCurrentBranch(projectPath);
    if (!isSafeBranchArg(targetBranch)) return { success: false, error: `Refusing to push branch "${targetBranch}"` };

    // The remote NAME, not its URL: `-u` then records `origin` as the upstream
    // (it used to record the token URL in .git/config) and origin/<branch>
    // is updated, which getRemoteStatus's ahead/behind reads.
    const args = ['push', '-u', 'origin', targetBranch];
    if (force) args.splice(1, 0, '--force');

    try {
      await this.remoteGit(projectPath, token, args);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Pull from the origin remote.
   *
   * With the token, this is a fetch WITH it followed by a local integrate step
   * WITHOUT it. A single `git pull` refreshes the index before it fetches --
   * running the fsmonitor, clean filters and the post-index-change hook, all
   * nameable by .git/config -- while the token file still exists; that was
   * reproduced in review. See planIntegration for how the second step
   * honours pull.rebase / pull.ff / branch.<name>.rebase.
   *
   * Two differences from `git pull origin <branch>` are intentional: a merge
   * commit reads "Merge remote-tracking branch 'origin/<branch>'" (and the
   * reflog "pull . refs/remotes/origin/<branch>"), and a rebase pull after an
   * upstream force-push uses the fork point, where the old
   * `pull <tokenUrl>` had no remote-tracking ref to find one from.
   */
  async pull(projectPath: string, branch?: string): Promise<{ success: boolean; conflicts?: string[]; error?: string }> {
    const token = this.getToken();
    if (!token) return { success: false, error: 'GitHub token not configured' };

    const remoteUrl = await this.getRemoteUrl(projectPath);
    if (!remoteUrl) return { success: false, error: 'No remote origin configured' };

    await this.scrubPersistedCredentialUrls(projectPath);
    const targetBranch = branch ?? await this.getCurrentBranch(projectPath);
    if (!isSafeBranchArg(targetBranch)) return { success: false, error: `Refusing to pull branch "${targetBranch}"` };

    try {
      if (await this.originIsCredentialTarget(projectPath)) {
        // An explicit refspec, so origin/<branch> is updated even for a remote
        // configured without a fetch refspec.
        const tracking = `refs/remotes/origin/${targetBranch}`;
        const plan = await this.planIntegration(projectPath, targetBranch, tracking);
        await this.authedGit(projectPath, token, ['fetch', 'origin', `+refs/heads/${targetBranch}:${tracking}`]);
        await this.integrateFetched(projectPath, tracking, plan);
      } else {
        await this.remoteGit(projectPath, token, ['pull', 'origin', targetBranch]);
      }
      return { success: true };
    } catch (err) {
      // Check for merge conflicts
      try {
        const status = await this.git(projectPath, ['status', '--porcelain']);
        const conflicts = status
          .split('\n')
          .filter(line => line.startsWith('UU') || line.startsWith('AA'))
          .map(line => line.slice(3).trim());

        if (conflicts.length > 0) {
          return { success: false, conflicts };
        }
      } catch { /* ignore */ }

      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Fetch from origin and compute ahead/behind status.
   */
  async getRemoteStatus(projectPath: string): Promise<GitRemoteStatus> {
    // Before the early return: a project whose remote is gone must still be
    // cleaned of a token URL the pre-#511 push left behind.
    await this.scrubPersistedCredentialUrls(projectPath);
    const remoteUrl = await this.getRemoteUrl(projectPath);
    if (!remoteUrl) {
      return { hasRemote: false, remoteUrl: null, owner: null, repo: null, ahead: 0, behind: 0, lastPushedAt: null };
    }

    const { owner, repo } = this.parseRemoteUrl(remoteUrl);
    const token = this.getToken();

    // Fetch latest refs from origin (requires auth)
    if (token) {
      try {
        await this.remoteGit(projectPath, token, ['fetch', 'origin', '--quiet']);
      } catch { /* network error, show stale data */ }
    }

    const currentBranch = await this.getCurrentBranch(projectPath);
    let ahead = 0;
    let behind = 0;

    try {
      const behindStr = await this.git(projectPath, ['rev-list', '--count', `HEAD..origin/${currentBranch}`]);
      behind = parseInt(behindStr.trim(), 10) || 0;
    } catch { /* no tracking branch yet */ }

    try {
      const aheadStr = await this.git(projectPath, ['rev-list', '--count', `origin/${currentBranch}..HEAD`]);
      ahead = parseInt(aheadStr.trim(), 10) || 0;
    } catch { /* no tracking branch yet — all local commits are "ahead" */
      try {
        const totalStr = await this.git(projectPath, ['rev-list', '--count', 'HEAD']);
        ahead = parseInt(totalStr.trim(), 10) || 0;
      } catch { /* empty repo */ }
    }

    return { hasRemote: true, remoteUrl, owner, repo, ahead, behind, lastPushedAt: null };
  }

  // ── Private Helpers ──

  /**
   * What the token-free half of pull() will do, decided BEFORE the fetch,
   * because that is when `git pull` decides it.
   *
   * Merge mode, and anything pull.ff=only governs, is `git pull . <tracking>`
   * in integrateFetched: pull.ff, merge options and hooks apply as ever. (With
   * pull.ff=only even a rebase pull only fast-forwards or fails, which is
   * what `pull .` does.)
   *
   * Rebase mode cannot go through `pull .`: pull only looks for a fork point
   * when its refspec names a branch of a named remote, which `.` is not, so
   * after an upstream force-push it would replay the commits upstream
   * rewrote (reproduced in review). So it mirrors what pull does itself:
   * `merge-base --fork-point` against origin/<branch> as it stands before the
   * fetch, then `rebase --onto <tracking> <fork point>`. When this fetch is
   * the one that moves origin/<branch>, the pre-fetch tip alone finds the
   * fork point. In the UI flow getRemoteStatus has usually moved it already,
   * so in practice the fork point comes from origin/<branch>'s reflog -- the
   * same as `git pull` after a `git fetch`. With reflogs off, both then
   * rebase without one.
   *
   * `interactive`, `preserve` and anything unparseable take the `pull .`
   * path, where git applies or rejects them exactly as before.
   */
  private async planIntegration(cwd: string, branch: string, tracking: string): Promise<IntegrationPlan> {
    const mode = await this.pullRebaseMode(cwd, branch);
    if (mode !== 'rebase' && mode !== 'merges') return { kind: 'pull' };
    const ff = await this.git(cwd, ['config', '--get', 'pull.ff']).catch(() => '');
    if (ff.trim().toLowerCase() === 'only') return { kind: 'pull' };
    // An unborn branch: pull's own "pull into void" path, not a rebase.
    const hasHead = await this.git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
    if (!hasHead) return { kind: 'pull' };
    const forkPoint = (await this.git(cwd, ['merge-base', '--fork-point', tracking, 'HEAD']).catch(() => '')).trim();
    return { kind: 'rebase', rebaseMerges: mode === 'merges', forkPoint: forkPoint || null };
  }

  /** The second, token-free half of pull(); see planIntegration. */
  private async integrateFetched(cwd: string, tracking: string, plan: IntegrationPlan): Promise<void> {
    const options = { timeoutMs: this.networkTimeoutMs };
    if (plan.kind === 'pull') {
      await this.git(cwd, ['pull', '.', tracking], options);
      return;
    }
    const args = ['rebase'];
    if (plan.rebaseMerges) args.push('--rebase-merges');
    await this.git(cwd, [...args, '--onto', tracking, plan.forkPoint ?? tracking], options);
  }

  /**
   * The effective pull rebase mode: branch.<name>.rebase, else pull.rebase,
   * parsed the way git parses it -- the non-boolean words first, then git's
   * own boolean reading (so a valueless key is true, `2` is true).
   */
  private async pullRebaseMode(cwd: string, branch: string): Promise<'merge' | 'rebase' | 'merges' | 'other'> {
    for (const key of [`branch.${branch}.rebase`, 'pull.rebase']) {
      let raw: string;
      try {
        raw = (await this.git(cwd, ['config', '--get', key])).trim().toLowerCase();
      } catch {
        continue; // unset
      }
      if (raw === 'merges' || raw === 'm') return 'merges';
      if (['interactive', 'i', 'preserve', 'p'].includes(raw)) return 'other';
      try {
        const bool = (await this.git(cwd, ['config', '--type=bool', '--get', key])).trim();
        return bool === 'true' ? 'rebase' : 'merge';
      } catch {
        return 'other'; // not a boolean: let git itself reject it
      }
    }
    return 'merge';
  }

  /**
   * Run a git command that talks to origin, with the PAT only when origin is
   * on the credential target.
   *
   * Anything else -- an ssh origin, a GitHub Enterprise host, or an origin
   * that a planted insteadOf/pushurl points elsewhere -- runs as plain git
   * with no token file in existence at all: nothing for the transport, its
   * hooks or its config-named commands to find, and ssh keeps working as it
   * did before #511. The helper-list reset and the timeout still apply.
   */
  private async remoteGit(cwd: string, token: string, args: string[]): Promise<string> {
    if (await this.originIsCredentialTarget(cwd)) return this.authedGit(cwd, token, args);

    try {
      return await this.git(cwd, args, { configArgs: ['-c', 'credential.helper='], timeoutMs: this.networkTimeoutMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only where it explains the failure; a divergent-branch or rebase
      // error has nothing to do with the token.
      if (!AUTH_FAILURE.test(message)) throw err;
      const { protocol, host } = this.credentialTarget;
      throw new Error(`${message} (origin is not a ${protocol}://${host}/ URL, so the GitHub token was not used;`
        + ` set origin to the repository's ${protocol} URL to use it)`);
    }
  }

  /**
   * True when every URL git would use for origin -- fetch and push, after
   * insteadOf/pushInsteadOf -- is on the credential target, over git's own
   * http transport. `remote.origin.vcs` is refused outright: it swaps in a
   * `git-remote-<vcs>` helper while `get-url` still prints the https URL.
   *
   * authedGit re-checks this before it writes the token file. What remains is
   * a config that changes between the check and the command: the protocol
   * pins in gitHardeningArgs cover git's built-in transports, not a custom
   * remote helper a project-level `protocol.<name>.allow` enables (see
   * KNOWN_PROTOCOLS).
   */
  private async originIsCredentialTarget(cwd: string): Promise<boolean> {
    return (await this.originCredentialUrls(cwd)) !== null;
  }

  /**
   * The URLs behind originIsCredentialTarget: every fetch and push URL of
   * origin when all of them are on the target, else null. authedGit pins
   * proactive auth for each of them exactly (see gitHardeningArgs).
   */
  private async originCredentialUrls(cwd: string): Promise<string[] | null> {
    const { protocol, host } = this.credentialTarget;
    const prefix = `${protocol}://${host}/`;
    // Present at all -- even set to an empty value -- is refused: decided by
    // the exit status, not by what the value trims to.
    const vcsSet = await this.git(cwd, ['config', '--get', 'remote.origin.vcs']).then(() => true, () => false);
    if (vcsSet) return null;
    try {
      const fetchUrls = await this.git(cwd, ['remote', 'get-url', '--all', 'origin']);
      const pushUrls = await this.git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']);
      // Split on newlines only and never trim: the URL checked here must be
      // byte for byte the one git uses and the one pinned.
      const urls = `${fetchUrls}\n${pushUrls}`.split('\n').filter(u => u !== '');
      const ok = urls.length > 0 && urls.every(u => u.startsWith(prefix) && isPlainRepoPath(u.slice(prefix.length)));
      return ok ? [...new Set(urls)] : null;
    } catch {
      return null;
    }
  }

  /**
   * Run a git command that talks to GitHub with the PAT.
   *
   * The token is written to a 0600 file in a fresh 0700 dir and handed to git
   * by a command-line credential helper (credentialHelperArgs), so it is in
   * neither argv nor the child's environment. The dir is removed on every
   * exit path, timeout included; the helper normally removes the file much
   * earlier, on git's first request.
   *
   * Refuses outright unless origin is on the credential target, so no caller
   * can write the token file for anywhere else by forgetting the check.
   */
  private async authedGit(cwd: string, token: string, args: string[]): Promise<string> {
    if (!TOKEN_SHAPE.test(token)) throw new Error('GitHub token contains characters that cannot be a token');
    const originUrls = await this.originCredentialUrls(cwd);
    if (originUrls === null) {
      throw new Error('Refusing to use the GitHub token: origin is not on GitHub over https');
    }

    const root = credentialRoot();
    sweepStaleCredentialDirs(root);
    const dir = mkdtempSync(join(root, CREDENTIAL_DIR_PREFIX));
    try {
      const tokenFile = join(dir, 'token');
      writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
      return await this.git(cwd, args, {
        configArgs: [
          ...credentialHelperArgs(tokenFile, this.credentialTarget),
          ...gitHardeningArgs(this.credentialTarget, originUrls),
        ],
        timeoutMs: this.networkTimeoutMs,
      });
    } catch (err) {
      // Belt and braces: git never sees the token in a URL any more, so it has
      // nothing to echo, but a failure message must not be the one place it
      // surfaces if that ever changes.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message.split(token).join('***'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Undo the on-disk leak left by the pre-#511 push: `git push -u <tokenUrl>`
   * recorded the token URL as branch.<name>.remote. Point each such branch
   * back at `origin`, which is what `push -u origin` records now.
   *
   * Runs on push, pull, status (even with no remote) and removeRemote, with or
   * without a token, so a project the user merely opens is cleaned too.
   * Reflog lines written by the old `pull <tokenUrl>` are NOT rewritten here
   * (#517); a token that ever landed there needs rotating regardless.
   *
   * Best effort. Failing to clean up an old leak must not block a push.
   */
  private async scrubPersistedCredentialUrls(cwd: string): Promise<void> {
    let listing: string;
    try {
      // -z: key and value separated by a newline, entries by NUL.
      listing = await this.git(cwd, ['config', '--local', '-z', '--get-regexp', '^branch\\..*\\.remote$']);
    } catch {
      return; // exit 1: no branch has a remote configured
    }
    for (const entry of listing.split('\0')) {
      const nl = entry.indexOf('\n');
      if (nl <= 0) continue;
      const key = entry.slice(0, nl);
      if (!PERSISTED_CREDENTIAL_URL.test(entry.slice(nl + 1))) continue;
      try {
        await this.git(cwd, ['config', '--local', '--replace-all', key, 'origin']);
      } catch { /* leave it; the push itself is unaffected */ }
    }
  }

  /**
   * Parse owner/repo from a GitHub remote URL.
   */
  private parseRemoteUrl(remoteUrl: string): { owner: string | null; repo: string | null } {
    // Handles both https://github.com/owner/repo.git and git@github.com:owner/repo.git
    const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) return { owner: null, repo: null };
    return { owner: match[1]!, repo: match[2]! };
  }

  private async getCurrentBranch(projectPath: string): Promise<string> {
    const output = await this.git(projectPath, ['branch', '--show-current']);
    return output.trim() || 'main';
  }

  /**
   * Run a git command via Bun.spawn. `configArgs` (`-c k=v` pairs) go before
   * the subcommand, and are kept apart so error messages still name it.
   */
  private async git(
    cwd: string,
    args: string[],
    options: { configArgs?: string[]; timeoutMs?: number } = {},
  ): Promise<string> {
    // Sanitized, not inherited - same reasoning as GitManager.run(): these
    // commands execute .git/hooks out of a model-written project tree. Nothing
    // credential-bearing may be added here either: hooks inherit this env.
    const timeoutMs = options.timeoutMs;
    const proc = Bun.spawn(['git', ...PROJECT_GIT_PINS, ...(options.configArgs ?? []), ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0' }),
      // Its own process group, so a timeout can take out git's children too.
      // Killing git alone leaves git-remote-https (and any hook) holding the
      // pipes open, and the reads below would wait on them indefinitely.
      // POSIX only: Windows has no process groups to signal, and there
      // `detached` means a new console window instead.
      //
      // NOTE for the Docker image: the ENTRYPOINT runs jarvis as PID 1 with no
      // init, so group-killed children reparented to it are not reaped and
      // stay as zombies (no memory, one pid each). Run the container with
      // `--init` (or add tini) if timeouts ever become frequent.
      detached: timeoutMs !== undefined && process.platform !== 'win32',
    });

    // Both pipes at once: a hook that fills the stderr pipe while nobody reads
    // it would otherwise block git, and this await, forever.
    const out = readPipe(proc.stdout);
    const err = readPipe(proc.stderr);

    let timedOut = false;
    let giveUpOnPipes: ReturnType<typeof setTimeout> | undefined;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      // Only a git still running timed out. After it exits, the kill still
      // runs: a hook's leftover background job may be what holds the pipes.
      if (proc.exitCode === null && proc.signalCode === null) timedOut = true;
      try {
        if (process.platform === 'win32') throw new Error('no process groups');
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
      // Something that left the group (a hook's `setsid cmd &`) can still
      // hold the pipes. Stop waiting for it rather than for ever.
      giveUpOnPipes = setTimeout(() => {
        out.cancel();
        err.cancel();
      }, PIPE_GRACE_MS);
    }, timeoutMs);

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr] = await Promise.all([out.text, err.text]);
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
      clearTimeout(giveUpOnPipes);
    }

    if (timedOut) throw new Error(`git ${args[0]} timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
    }

    return stdout;
  }

  /**
   * Make an authenticated request to the GitHub REST API.
   */
  private async githubFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const token = this.getToken();
    if (!token) throw new Error('GitHub token not configured');

    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'JARVIS-SiteBuilder',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`GitHub API error (${res.status}): ${err.message ?? res.statusText}`);
    }

    return res;
  }
}
