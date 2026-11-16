import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** True when `dir` exists and can be written to, or can be created because the nearest folder above it that exists can. */
export function canWriteOrCreate(dir: string): boolean {
  let at = resolve(dir);
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
  try {
    accessSync(at, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `~/.jarvis/<sub>`, which is where these folders have always lived, so an
 * install with a normal home keeps using them. When that place cannot be
 * written (a read-only or missing home, a container) and the instance has its
 * own data dir (`JARVIS_HOME`), the folder goes inside the data dir instead:
 * an instance that names its data dir needs nothing from `$HOME`. With neither,
 * the home path is returned and fails the way it always did.
 */
export function homeJarvisDir(...sub: string[]): string {
  return homeJarvisDirFor(homedir(), process.env.JARVIS_HOME, ...sub);
}

/** The same rule with its two inputs given, for callers and tests that must not read the process's own home. */
export function homeJarvisDirFor(home: string, dataDir: string | undefined, ...sub: string[]): string {
  const inHome = join(home, '.jarvis', ...sub);
  const own = dataDir?.trim();
  if (!own || canWriteOrCreate(inHome)) return resolve(inHome);
  return resolve(own, ...sub);
}

/** The site builder's projects folder as the default config spells it. */
export const DEFAULT_SITE_PROJECTS_DIR = '~/.jarvis/projects';

/**
 * The site builder's projects folder. The default (`sites.projects_dir` unset,
 * or left at `~/.jarvis/projects`, which the config defaults always fill in)
 * goes through `homeJarvisDir`, so a read-only home with `JARVIS_HOME` set
 * keeps projects in the data dir; any other configured folder is used as given.
 */
export function siteProjectsDir(configured: string | undefined): string {
  if (!configured || configured.trim() === DEFAULT_SITE_PROJECTS_DIR) return homeJarvisDir('projects');
  return configured.replace(/^~(?=$|[\\/])/, homedir());
}
