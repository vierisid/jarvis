/**
 * Per-call-site leak probe. Run as a CHILD process by spawn-env.test.ts.
 *
 * Why a child process rather than an in-process test: Bun spawns children from
 * the environment snapshot taken at process start, so assigning
 * `process.env.CANARY` inside a `bun test` run does NOT reach a child spawned
 * with an inherited environment. A canary planted that way is invisible to
 * exactly the two call sites that inherit hardest (the ones that omit `env`
 * entirely), and the test would pass while they leak. The test therefore
 * launches this file with the canary already in its real startup environment.
 *
 * PATH is pointed at a directory of fake `bunx` / `make` / `git` executables
 * that dump their own environment and exit 0, so the assertion is made against
 * what a real grandchild process actually received -- not against the return
 * value of a helper.
 *
 * argv: <site> <workDir> (PATH and the canary come from the spawned env)
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectManager } from '../project-manager.ts';
import { DevServerManager } from '../dev-server-manager.ts';
import { GitManager } from '../git-manager.ts';
import { GitHubManager } from '../github-manager.ts';
import { createSiteBuilderTools } from '../builder-tools.ts';
import type { SiteBuilderConfig } from '../types.ts';

const site = process.argv[2]!;
const workDir = process.argv[3]!;

function config(projectsDir: string): SiteBuilderConfig {
  return {
    enabled: true,
    projects_dir: projectsDir,
    port_range_start: 39000,
    port_range_end: 39999,
    auto_commit: false,
    max_concurrent_servers: 2,
  };
}

const projectsDir = join(workDir, 'projects');
mkdirSync(projectsDir, { recursive: true });

const dumpDir = join(workDir, 'dumps');

/**
 * Wait until a fake executable has finished writing its dump.
 *
 * `DevServerManager.start()` returns as soon as it has spawned `make dev`, so
 * without this the probe would stop the server (and exit) before the child had
 * written anything, and the test would see no dump rather than a clean one.
 */
async function waitForDump(prefix: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readdirSync(dumpDir).some(f => f.startsWith(prefix) && f.endsWith('.env'));
    if (hit) return;
    await Bun.sleep(50);
  }
  // Throw rather than fall through: a silent timeout surfaces in the test as a
  // confusing `expect(undefined).toBeDefined()` instead of saying what broke.
  throw new Error(`spawn-env-probe: no dump matching "${prefix}" after ${timeoutMs}ms`);
}

switch (site) {
  // project-manager.ts: `bunx create-*` AND `make install`, in one real call.
  case 'create-project': {
    const pm = new ProjectManager(config(projectsDir), new GitManager());
    await pm.createProject('probe-app', 'vite-react');
    break;
  }

  // dev-server-manager.ts: the long-running `make dev`.
  case 'dev-server': {
    const projectPath = join(projectsDir, 'probe-app');
    mkdirSync(projectPath, { recursive: true });
    const dsm = new DevServerManager(config(projectsDir));
    try {
      await dsm.start('probe-app', projectPath);
      await waitForDump('make-dev');
    } finally {
      // Kill by the handle we started; the fake exits on its own anyway.
      await dsm.stopAll();
    }
    break;
  }

  // git-manager.ts: the private run() behind every git operation.
  case 'git-manager': {
    const projectPath = join(projectsDir, 'probe-app');
    mkdirSync(projectPath, { recursive: true });
    const gm = new GitManager();
    // A call with no name check in front: the fake git prints nothing, which
    // checkBranchName would read as check-ref-format rewriting the name.
    await gm.getCurrentBranch(projectPath);
    break;
  }

  // git-manager.ts: the three static spawns (`git --version`, `git config
  // --global user.name` / `user.email`). They do not run project code, but
  // they passed no env at all, which is how they were missed the first time.
  case 'git-statics': {
    await GitManager.isInstalled();
    await waitForDump('git---version');
    await GitManager.getGlobalAuthor();
    await waitForDump('git-config');
    break;
  }

  // github-manager.ts: its own private git(). addRemote needs no token, so
  // this can never silently skip for lack of credentials.
  case 'github-manager': {
    const projectPath = join(projectsDir, 'probe-app');
    mkdirSync(projectPath, { recursive: true });
    const ghm = new GitHubManager();
    await ghm.addRemote(projectPath, 'https://example.invalid/owner/repo.git');
    break;
  }

  // builder-tools.ts: `sh -c <model text>`. This one reports through the tool's
  // own return value, which is what the model would see.
  case 'run-command': {
    const projectPath = join(projectsDir, 'probe-app');
    mkdirSync(projectPath, { recursive: true });
    const pm = new ProjectManager(config(projectsDir), new GitManager());
    const tools = createSiteBuilderTools(pm, new GitManager(), new GitHubManager());
    const runCommand = tools.find(t => t.name === 'site_run_command')!;
    const output = await runCommand.execute({ project_id: 'probe-app', command: 'env' });
    console.log('---RUN-COMMAND-OUTPUT---');
    console.log(output);
    // End marker: process.exit() below can truncate a buffered pipe write, and
    // a truncated env dump would look like a clean one (the leaked names would
    // simply not be there to flag). The test requires this marker.
    console.log('---RUN-COMMAND-END---');
    break;
  }

  // Positive control: prove the arrangement can SEE a leak. Spawns the same
  // fake binary with `env` omitted, which is what the unfixed call sites did.
  // If this stops showing the canary, the probe is broken and every other
  // assertion in this file is vacuous.
  case 'control': {
    const projectPath = join(projectsDir, 'probe-app');
    mkdirSync(projectPath, { recursive: true });
    const proc = Bun.spawn(['make', 'control'], { cwd: projectPath, stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    break;
  }

  default:
    throw new Error(`unknown site: ${site}`);
}

// Let any buffered stdout reach the pipe before exiting.
await Bun.sleep(0);

// Exit explicitly. `site_run_command` races its command against a 30s
// setTimeout that it never clears, so the timer keeps this process alive for a
// further 30 seconds after the command has already returned.
process.exit(0);
