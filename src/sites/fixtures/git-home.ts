/**
 * Point HOME and XDG_CONFIG_HOME at an empty temp dir for the rest of a test
 * file, so git sees no global config. Both are on the subprocess allowlist,
 * and sanitizedEnv reads process.env at call time, so every git the code under
 * test spawns picks this up. Returns the undo, for afterAll.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function isolateGitHome(): () => void {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = mkdtempSync(join(tmpdir(), 'jarvis-git-home-'));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  };
}
