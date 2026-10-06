/**
 * Built-in Tools — The Hands
 *
 * Concrete tool implementations that the agent can call:
 * run_command, read_file, write_file, list_directory
 */

import {
  readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync, chmodSync, renameSync, rmSync,
  realpathSync, openSync, closeSync, fstatSync, readSync, readlinkSync, constants as fsConstants,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { hostname, platform, arch, cpus, version } from 'node:os';
import { TerminalExecutor } from '../terminal/executor.ts';
import { WSLBridge } from '../terminal/wsl-bridge.ts';
import { BrowserController, type PageSnapshot } from '../browser/session.ts';
import { checkNavigationUrl } from '../browser/url-policy.ts';
import { checkUploadPath, pageOrigin, uploadTargetRefusal } from '../browser/upload-policy.ts';
import type { ToolDefinition, ToolResult } from './registry.ts';
import type { LLMTool } from '../../llm/provider.ts';
import {
  routeToSidecar, routeScreenshotToSidecar, routeBrowserReadToSidecar, autoTargetForCapability, resolveToolTarget,
  type SidecarPageRead,
} from './sidecar-route.ts';
import { WebappTemplateDelivery, globalWebappTemplateDelivery, usablePageUrl } from './webapp-template-injection.ts';
import { listSidecarsTool } from './sidecar-list.ts';
import { DESKTOP_TOOLS, localScreenshotResult } from './desktop.ts';
import { UI_TOOLS } from './ui.ts';
import { SKILL_TOOLS } from './skills.ts';

const terminal = new TerminalExecutor({ timeout: 30000 });

// Shared browser controller (lazy-connected on first browser tool use)
export const browser = new BrowserController();

import { isNoLocalTools, LOCAL_DISABLED_MSG, isLocalBrowserDisabled, LOCAL_BROWSER_DISABLED_MSG, getDefaultCwd } from './local-tools-guard.ts';
import { siteProjectExecOnWrite } from '../../sites/project-exec-paths.ts';
import {
  execOnWrite, getSiteProjectsDir, isSecretInode, policyHome, relativeBases, routedGitRefusal, scanForDaemonSecrets,
  secretInodeRefusal,
  secretListRefusal, secretRead, secretReadRefusal, secretRefusalTextFor, secretScanRefusal, siteGitRefusal,
} from './file-path-policy.ts';
import { forCard } from '../../util/card-text.ts';
// Re-export for convenience
export { setNoLocalTools, isNoLocalTools, setDefaultCwd } from './local-tools-guard.ts';


/**
 * Convert a ToolDefinition's parameters to JSON Schema for LLM tool use.
 */
export function toolDefToLLMTool(tool: ToolDefinition): LLMTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(tool.parameters)) {
    const schema: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };
    // Emit the enum so the model is given the allowed values by the schema
    // itself, not a prose list it can ignore. `ToolRegistry` enforces the
    // same set on execution, so what is advertised is what is accepted.
    if (param.enum && param.enum.length > 0) schema.enum = param.enum;
    properties[name] = schema;
    if (param.required) {
      required.push(name);
    }
  }

  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties,
      required,
    },
  };
}

/**
 * The file tools' refusal of a site project's git internals (#522). Run
 * BEFORE sidecar routing: a sidecar on the brain's own machine opens the
 * brain's files and knows nothing about site projects, so a relative path is
 * judged against every cwd it could be opened from. See siteGitRefusal.
 */
function siteGitRefusalFor(params: Record<string, unknown>): string | null {
  const path = String(params.path ?? '');
  return siteGitRefusal(path, relativeBases())
    ?? (params.target || autoTargetForCapability('filesystem') ? routedGitRefusal(path) : null);
}

/**
 * The file tools' refusal of the daemon's own credentials (#528). Run BEFORE
 * sidecar routing, like siteGitRefusalFor and for the same reason: a sidecar on
 * the brain's own machine opens the brain's files, and a routed path is judged
 * by spelling (see secretRead's name tier), so `read_file {target, path:
 * "~/.jarvis/.secrets.key"}` is refused too.
 */
function secretRefusalFor(params: Record<string, unknown>): string | null {
  return secretReadRefusal(params.path, { bases: relativeBases() });
}

/**
 * The secret verdict for a read, taken ONCE.
 *
 * Classifying twice -- once to refuse, once to ask whether the bytes need
 * scanning -- can disagree: a symlink retargeted in between, an inode cache
 * invalidated by a concurrent key write, a staging dir appearing. The second
 * answer was then used only for its `scanOnly` bit, so a definite hit that
 * appeared late was dropped instead of refusing. One call, both halves used.
 */
function secretVerdict(params: Record<string, unknown>): { refusal: string | null; scanOnly: boolean } {
  const hit = secretRead(params.path, { bases: relativeBases() });
  if (!hit) return { refusal: null, scanOnly: false };
  if (hit.scanOnly) return { refusal: null, scanOnly: true };
  return { refusal: secretRefusalTextFor(params.path, hit), scanOnly: false };
}

/** What `read_file` will hand back at most, before truncation is reported. */
const READ_FILE_LIMIT = 100 * 1024;

/**
 * The largest cut at or below `end` that does not split a UTF-8 sequence.
 *
 * The read is bounded in BYTES, which is the point -- the old code decoded the
 * whole file and then sliced characters -- but cutting mid-sequence puts a U+FFFD
 * at the end of every truncated non-ASCII file. Walks back at most three
 * continuation bytes (`10xxxxxx`), so the worst case drops three bytes.
 */
function utf8Boundary(buf: Buffer, end: number): number {
  for (let i = end; i > end - 4 && i > 0; i -= 1) {
    if ((buf[i - 1]! & 0xc0) !== 0x80) {
      // `i - 1` starts a sequence; keep it only if it fits entirely before `end`.
      const lead = buf[i - 1]!;
      const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      return i - 1 + width <= end ? end : i - 1;
    }
  }
  return end;
}

/** A file size a person can read at a glance, for an approval card. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes === 1) return '1 byte';
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Where a descriptor really landed, or null when the platform cannot say.
 *
 * Linux answers through `/proc/self/fd/<n>`, which is the only way to learn the
 * path a descriptor actually resolved to, and it appends `" (deleted)"` for an
 * unlinked inode -- stripped, or the suffix would be classified as part of the
 * name. macOS needs `fcntl(F_GETPATH)`, which node does not expose, and Windows
 * has no equivalent; both fall back to the path-based verdict already taken,
 * plus the inode test, which needs no path at all.
 *
 * Exported ONLY so it can be asserted directly. There is no integration
 * fixture that makes this function load-bearing: a hard link gives
 * `landed === filePath` by construction, and a symlink is already resolved
 * identically by the pre-open `resolveReal`, so every alias a test can build
 * is refused by the inode pass before the descriptor is consulted. It is a
 * TOCTOU backstop, and the only honest way to pin it is to call it. #546 made
 * that necessary: it reads `/proc/self/fd`, whose directory the kernel
 * reassigns to root when the daemon becomes non-dumpable, so a test has to
 * prove it still answers. See src/daemon/process-hardening.test.ts.
 */
export function descriptorPath(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, '');
  } catch {
    return null;
  }
}

/**
 * Read a file the policy has already allowed by path, judging the descriptor
 * that is actually opened.
 *
 * The path was resolved and classified a moment ago; between then and the read
 * it could have been replaced. So the file is opened once and everything after
 * that is decided from the descriptor: `fstat` for what kind of file it is and
 * which inode it is, `/proc/self/fd` for where it landed, and the bytes come
 * from that same descriptor. Nothing re-resolves the path, so there is nothing
 * left to swap.
 *
 * `O_NONBLOCK` because opening a FIFO for reading otherwise blocks until a
 * writer appears, and the daemon with it; `fstat` then refuses anything that is
 * not a regular file, as the pre-checks did.
 *
 * The read is bounded rather than slurped: the old code read the whole file and
 * then took the first 100 KB, so `read_file /proc/kcore` (a REGULAR file of
 * 140 TB) or any multi-GB file tried to allocate all of it.
 */
function readJudgedFile(filePath: string, requested: unknown, scanOnly: boolean): string {
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO cannot hang the daemon on open; O_NOCTTY so that if a
    // regular file were swapped for a tty between the pre-check and here, the
    // daemon does not acquire a controlling terminal whose SIGHUP would kill it.
    // Both are no-ops for a regular file, and undefined on Windows, where
    // `O_RDONLY | undefined` is still O_RDONLY.
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `Error: File not found: ${filePath}`;
    if (code === 'EACCES') return `Error: Permission denied: ${filePath}`;
    return `Error: Cannot read ${filePath}: ${code ?? 'open failed'}`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return `Error: Not a regular file: ${filePath}`;
    // Identity, which no spelling and no race can change. An inode of 0 is not
    // an identity: some network and Windows volumes report it for every file,
    // and a cached `dev:0` would then refuse everything on that volume.
    if (st.ino && isSecretInode(st.dev, st.ino)) return secretInodeRefusal(requested);
    // Where the descriptor really landed, which can differ from the path if it
    // was retargeted after the pre-checks. A definite verdict refuses; a
    // scan-only one is carried into the scan below, or a shell rc swapped in
    // here would come back unscanned.
    let scan = scanOnly;
    const landed = descriptorPath(fd);
    if (landed && landed !== filePath) {
      const hit = secretRead(landed, { bases: relativeBases() });
      // Refuse naming the path the CALLER asked for: `landed` is the resolved
      // path, and putting that in a model-facing message would disclose where a
      // symlink really goes.
      if (hit && !hit.scanOnly) return secretRefusalTextFor(requested, hit);
      if (hit?.scanOnly) scan = true;
    }

    const buf = Buffer.allocUnsafe(READ_FILE_LIMIT + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got <= 0) break;
      n += got;
    }
    const truncated = n > READ_FILE_LIMIT;
    const content = buf.toString('utf-8', 0, utf8Boundary(buf, Math.min(n, READ_FILE_LIMIT)));
    // A file that legitimately holds environment settings comes back only if it
    // does not actually assign one of the daemon's own credentials. Scanning
    // what is RETURNED is enough: anything past the limit is not returned.
    if (scan) {
      const name = scanForDaemonSecrets(content);
      if (name) return secretScanRefusal(requested, name);
    }
    if (!truncated) return content;
    // A procfs stream reports size 0 while still having bytes, so there is no
    // honest number to give for it: say what was read rather than inventing one.
    const size = Number(st.size);
    return `${content}\n... [truncated, file is ${size > 0 ? `${size} bytes` : `over ${READ_FILE_LIMIT} bytes`}]`;
  } finally {
    closeSync(fd);
  }
}

/**
 * Pin a relative `path` to the absolute one it means now, for a call about to
 * be judged. An approval can be clicked after the site chat that asked for it
 * has ended, when the same relative path would resolve against home, and a
 * daemon restart forgets the cwd altogether; the frozen path is what the card
 * names and what runs. A call routed to a sidecar keeps its spelling: the
 * brain's cwd means nothing there.
 */
function freezePath(params: Record<string, unknown>): Record<string, unknown> {
  const path = params.path;
  if (typeof path !== 'string' || !path || isAbsolute(path)) return params;
  if (params.target || autoTargetForCapability('filesystem')) return params;
  return { ...params, path: resolve(getDefaultCwd() || policyHome(), path) };
}

// --- Tool Implementations ---

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description: 'Execute a shell command and return the output. Use this to run terminal commands, scripts, or system utilities. Optionally specify a "target" sidecar name/ID to run the command on a remote machine instead of locally. The command must be valid for the OS of the machine it runs on -- the target machine is often not the same OS as the brain; check list_sidecars when unsure.',
  category: 'terminal',
  parameters: {
    command: {
      type: 'string',
      description: 'The shell command to execute',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to run on a remote machine (omit for local execution)',
      required: false,
    },
    cwd: {
      type: 'string',
      description: 'Working directory for the command (optional, defaults to home directory)',
      required: false,
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds (optional, defaults to 30000)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = (params.target as string | undefined) || autoTargetForCapability('terminal');
    if (target) {
      return routeToSidecar(target, 'run_command', {
        command: params.command,
        cwd: params.cwd,
        timeout: params.timeout,
      }, 'terminal');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const command = params.command as string;
    const explicitCwd = params.cwd as string | undefined;
    const cwd = explicitCwd || getDefaultCwd() || homedir();
    const timeout = (params.timeout as number) || undefined;

    const result = await terminal.execute(command, { cwd, timeout });

    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += (output ? '\n' : '') + `[stderr] ${result.stderr}`;
    if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;

    // Truncate very large outputs
    if (output.length > 10000) {
      output = output.slice(0, 10000) + '\n... [truncated, output was ' + output.length + ' chars]';
    }

    return output || '[no output]';
  },
};

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file from disk. Returns the file content as text. Optionally specify a "target" sidecar to read from a remote machine.',
  category: 'file-ops',
  parameters: {
    path: {
      type: 'string',
      description: 'The absolute or relative path to the file to read',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to read from a remote machine (omit for local)',
      required: false,
    },
  },
  freezeArguments: freezePath,
  execute: async (params) => {
    const refused = siteGitRefusalFor(params);
    if (refused) return refused;
    // Classified once, before routing: a sidecar on this machine opens these
    // same files, and a routed path is judged by spelling.
    const verdict = secretVerdict(params);
    if (verdict.refusal) return verdict.refusal;
    const target = (params.target as string | undefined) || autoTargetForCapability('filesystem');
    if (target) {
      return routeToSidecar(target, 'read_file', { path: params.path }, 'filesystem');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const rawPath = params.path as string;
    const baseCwd = getDefaultCwd() || policyHome();
    const filePath = resolve(baseCwd, rawPath);

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return `Error: Path is a directory, not a file: ${filePath}`;
    }
    // A FIFO blocks readFileSync, and the whole daemon with it, until a
    // writer shows up; a device like /dev/zero reports size 0 and never ends.
    if (!stat.isFile()) {
      return `Error: Not a regular file: ${filePath}`;
    }

    // A file that may hold the daemon's environment is returned only if its
    // bytes do not assign one of its credentials; readJudgedFile decides that
    // from what it actually reads.
    return readJudgedFile(filePath, params.path, verdict.scanOnly);
  },
};

/**
 * The #558 site-project rating for a path this tool was handed, under every
 * base it could resolve against. Null when there is no site projects dir, the
 * path is outside it, or the site classifier says the file is ordinary content.
 */
function siteProjectHit(requested: unknown): { kind: string; path: string; lands?: string } | null {
  if (!getSiteProjectsDir()) return null;
  const spelled = String(requested ?? '');
  if (!spelled) return null;
  const candidates = isAbsolute(spelled) ? [spelled] : relativeBases().map((base) => resolve(base, spelled));
  for (const candidate of candidates) {
    const hit = siteProjectExecOnWrite(candidate);
    if (hit) return { ...hit, path: candidate };
  }
  return null;
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file on disk. Creates the file if it does not exist, overwrites if it does. Optionally specify a "target" sidecar to write on a remote machine.',
  category: 'file-ops',
  parameters: {
    path: {
      type: 'string',
      description: 'The absolute or relative path to the file to write',
      required: true,
    },
    content: {
      type: 'string',
      description: 'The content to write to the file',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to write on a remote machine (omit for local)',
      required: false,
    },
  },
  /**
   * `write_data` is the floor. A write to a path something runs as code -- a
   * shell startup file, git config or hooks, an autostart entry, a unit, a
   * crontab, SSH config, an existing executable, Jarvis's own data -- is
   * running a command later, so it is rated `execute_command` (#522). Not
   * refused: an agent below that level gets an approval card instead of a
   * denial, and the card says what the file is. See file-path-policy.ts for
   * what counts and why the path is judged under more than one resolution.
   */
  authorityGate: (params) => {
    // `execOnWrite` says nothing about a site project -- it calls that the
    // site builder's contract (file-path-policy.ts). Since #558 that contract
    // exists, so ask it: otherwise the same write to `<projects>/shop/Makefile`
    // costs an approval card through `site_write_file` and nothing at all
    // through this tool, and the model chooses the tool.
    const hit = execOnWrite(params.path) ?? siteProjectHit(params.path);
    if (!hit) return null;
    // The card names the file that made this an exec-on-write, resolved: a
    // relative path is judged against more than one base, and `.bashrc` on a
    // card could be the project's or home's. The deferred executor compares
    // this sentence with the approved one, so a call whose target moved is
    // not run under the old click.
    // A routed call names the sidecar and keeps its own spelling: the sidecar
    // resolves it, not the brain.
    const routedTo = params.target || autoTargetForCapability('filesystem');
    const shown = routedTo ? `${String(params.path)} on ${String(routedTo)}`
      : hit.lands ? `${hit.path} (lands on ${hit.lands})` : hit.path;
    return {
      actionCategory: 'execute_command',
      confirm: 'above_level',
      // The path goes last, whitespace collapsed and capped at a card's
      // size: it is the value being approved, and nothing after it can pose
      // as the rest of the sentence.
      intent: `Write a file that can run as code (${hit.kind}): ${forCard(shown)}`,
    };
  },
  freezeArguments: freezePath,
  execute: async (params) => {
    const refused = siteGitRefusalFor(params);
    if (refused) return refused;
    const target = (params.target as string | undefined) || autoTargetForCapability('filesystem');
    if (target) {
      return routeToSidecar(target, 'write_file', { path: params.path, content: params.content }, 'filesystem');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const rawPath = params.path as string;
    const baseCwd = getDefaultCwd() || policyHome();
    const filePath = resolve(baseCwd, rawPath);
    const content = params.content as string;
    let existing: ReturnType<typeof statSync> | undefined;
    try {
      existing = statSync(filePath);
    } catch { /* new file */ }
    // Opening a FIFO for writing blocks until a reader appears, and the
    // daemon with it; a device is not a file either.
    if (existing && !existing.isFile()) return `Error: Not a regular file: ${filePath}`;

    // A file with other hard links is replaced, not written in place, as the
    // site tools do (#516): bun's hardlink backend links node_modules to its
    // global cache, which other projects and the daemon's own dependencies
    // share, and an in-place write through one name rewrites all of them. A
    // sibling renamed over retargets this name only; the mode is kept.
    if (existing && Number(existing.nlink) > 1) {
      // Rename onto the file the path names, not onto the path: when the
      // path is a symlink to the hard-linked file, renaming over the link
      // would turn it into a plain file and leave the target untouched.
      const dest = realpathSync(filePath);
      const temp = join(dirname(dest), `.${randomUUID()}.jarvis-write.tmp`);
      try {
        writeFileSync(temp, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
        chmodSync(temp, Number(existing.mode) & 0o777);
        renameSync(temp, dest);
      } finally {
        rmSync(temp, { force: true });
      }
      return `File written successfully: ${filePath} (${content.length} bytes)`;
    }

    writeFileSync(filePath, content, 'utf-8');
    return `File written successfully: ${filePath} (${content.length} bytes)`;
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: 'List the contents of a directory. Returns file and folder names with their types and sizes. Optionally specify a "target" sidecar to list on a remote machine.',
  category: 'file-ops',
  parameters: {
    path: {
      type: 'string',
      description: 'The absolute or relative path to the directory to list',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to list on a remote machine (omit for local)',
      required: false,
    },
  },
  freezeArguments: freezePath,
  execute: async (params) => {
    const refused = siteGitRefusalFor(params);
    if (refused) return refused;
    const secret = secretListRefusal(params.path, { bases: relativeBases() });
    if (secret) return secret;
    const target = (params.target as string | undefined) || autoTargetForCapability('filesystem');
    if (target) {
      return routeToSidecar(target, 'list_directory', { path: params.path }, 'filesystem');
    }

    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;

    const rawPath = params.path as string;
    const baseCwd = getDefaultCwd() || policyHome();
    const dirPath = resolve(baseCwd, rawPath);

    if (!existsSync(dirPath)) {
      return `Error: Directory not found: ${dirPath}`;
    }

    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return `Error: Path is a file, not a directory: ${dirPath}`;
    }

    const entries = readdirSync(dirPath);
    const lines: string[] = [];

    for (const entry of entries) {
      try {
        const entryPath = `${dirPath}/${entry}`;
        const entryStat = statSync(entryPath);
        const type = entryStat.isDirectory() ? 'dir' : 'file';
        const size = entryStat.isDirectory() ? '' : ` (${entryStat.size} bytes)`;
        lines.push(`${type}  ${entry}${size}`);
      } catch {
        lines.push(`???  ${entry}`);
      }
    }

    if (lines.length === 0) {
      return `[empty directory: ${dirPath}]`;
    }

    return lines.join('\n');
  },
};

// --- Clipboard / Screenshot / System Info helpers ---

function localClipboardRead(): string {
  const os = platform();
  if (os === 'darwin') {
    return execSync('pbpaste', { encoding: 'utf-8' });
  } else if (os === 'win32') {
    return execSync('powershell -command Get-Clipboard', { encoding: 'utf-8' }).trimEnd();
  } else if (WSLBridge.isWSL()) {
    // On WSL the X clipboard (xclip/xsel via WSLg) is NOT the clipboard the
    // user copies/pastes with -- that's the Windows clipboard. Read it through
    // Windows interop so workflows see what the user actually copied.
    return execSync('powershell.exe -NoProfile -Command Get-Clipboard', { encoding: 'utf-8' }).replace(/\r\n/g, '\n').trimEnd();
  } else {
    try {
      return execSync('xclip -selection clipboard -o', { encoding: 'utf-8' });
    } catch {
      return execSync('xsel --clipboard --output', { encoding: 'utf-8' });
    }
  }
}

function localClipboardWrite(content: string): void {
  const os = platform();
  if (os === 'darwin') {
    execSync('pbcopy', { input: content, encoding: 'utf-8' });
  } else if (os === 'win32') {
    execSync('powershell -command Set-Clipboard', { input: content, encoding: 'utf-8' });
  } else if (WSLBridge.isWSL()) {
    // Write to the Windows clipboard via interop. `clip.exe` is the simplest
    // sink and is always present on WSL; it consumes stdin verbatim. (xclip/
    // xsel would only populate the WSLg X clipboard, which Windows apps and
    // the desktop sidecar's clipboard observer never see.)
    execSync('clip.exe', { input: content, encoding: 'utf-8' });
  } else {
    try {
      execSync('xclip -selection clipboard', { input: content, encoding: 'utf-8' });
    } catch {
      execSync('xsel --clipboard --input', { input: content, encoding: 'utf-8' });
    }
  }
}

function localCaptureScreen(): string {
  const os = platform();
  const tmp = `/tmp/jarvis-screenshot-${Date.now()}.png`;
  if (os === 'darwin') {
    execSync(`screencapture -x ${tmp}`);
  } else if (os === 'win32') {
    execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${tmp}') }"`);
  } else {
    try {
      execSync(`scrot ${tmp}`);
    } catch {
      execSync(`import -window root ${tmp}`);
    }
  }
  const data = readFileSync(tmp);
  unlinkSync(tmp);
  return data.toString('base64');
}

function localSystemInfo(): Record<string, unknown> {
  return {
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    cpus: cpus().length,
    node_version: version(),
  };
}

// --- Clipboard / Screenshot / System Info tools ---

export const getClipboardTool: ToolDefinition = {
  name: 'get_clipboard',
  description: 'Read the clipboard contents. Optionally specify a "target" sidecar name/ID to read from a remote machine instead of locally.',
  category: 'general',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    const auto = target || autoTargetForCapability('clipboard');
    if (auto) return routeToSidecar(auto, 'get_clipboard', {}, 'clipboard');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const content = localClipboardRead();
      return content || '[clipboard is empty]';
    } catch (err) {
      return `Error reading clipboard: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const setClipboardTool: ToolDefinition = {
  name: 'set_clipboard',
  description: 'Write text to the clipboard. Optionally specify a "target" sidecar name/ID to write to a remote machine instead of locally.',
  category: 'general',
  parameters: {
    content: {
      type: 'string',
      description: 'The text to write to the clipboard',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    const auto = target || autoTargetForCapability('clipboard');
    if (auto) return routeToSidecar(auto, 'set_clipboard', { content: params.content }, 'clipboard');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      localClipboardWrite(params.content as string);
      return 'Clipboard updated.';
    } catch (err) {
      return `Error writing clipboard: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const captureScreenTool: ToolDefinition = {
  name: 'capture_screen',
  description: 'Take a screenshot of the screen. Optionally specify a "target" sidecar name/ID to capture a remote machine instead of locally.',
  category: 'general',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    const auto = target || autoTargetForCapability('screenshot');
    // An image block, like desktop_screenshot's (#658); stringifying the
    // reply handed the model truncated base64 instead of a picture.
    if (auto) return routeScreenshotToSidecar(auto, {}, false);
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      // The same shape as the sidecar branch above; a stringified descriptor
      // reached the model as a truncated prefix of base64, like #658's.
      // Compacted when the raw PNG is over the image cap (#711), as the
      // routed branch is.
      return localScreenshotResult(localCaptureScreen(), 'image/png', 'Screenshot captured', false);
    } catch (err) {
      return `Error capturing screen: ${err instanceof Error ? err.message : err}`;
    }
  },
};

export const getSystemInfoTool: ToolDefinition = {
  name: 'get_system_info',
  description: 'Get system information (hostname, OS, architecture, CPU count). Optionally specify a "target" sidecar name/ID to query a remote machine instead of locally.',
  category: 'general',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID for remote execution (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = params.target as string | undefined;
    const auto = target || autoTargetForCapability('system_info');
    if (auto) return routeToSidecar(auto, 'get_system_info', {}, 'system_info');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    return JSON.stringify(localSystemInfo(), null, 2);
  },
};

// --- Browser Tool Helpers ---

// Formatter limits — keep in sync with sidecar/browser_snapshot.go.
//
// EVERY limit here counts CODE POINTS (`Array.from`), not UTF-16 units and not
// bytes (#597). `.slice`/`.length` are UTF-16 units while the sidecar's port
// sliced the same fields by BYTES, so the two formatters disagreed about the
// same page the moment it was not ASCII -- and either counting can cut a
// character in half, which reaches the model as a lone surrogate or a U+FFFD.
// sidecar/testdata/snapshot_parity_expected.txt is the golden rendering both
// sides are held to, by a Go test and by snapshot-format-parity.test.ts.
const MAX_PAGE_TEXT = 2000;   // chars of visible page text
const MAX_ELEMENTS = 80;      // interactive elements shown to LLM
const MAX_SAME_ROLE = 15;     // max elements with the same role (e.g., gridcell)
const MAX_ELEMENT_TEXT = 50;  // chars of an element's own text
const MAX_ELEMENT_HREF = 80;  // chars of an href
// Attribute values, and the Key Elements labels built from them. The snapshot
// script already cuts every attribute at 200 UTF-16 units (never more than 200
// code points), so this is a bound the formatter holds on its own rather than a
// second cut of the same value.
const MAX_ELEMENT_ATTR = 200;

/**
 * Caps for the two lines a PAGE writes into the rendered snapshot (#597).
 *
 * `Page:` is `document.title` and `URL:` is `location.href`, both chosen by the
 * page and both previously uncapped. Remotely that dropped the whole read at
 * the brain's 2 MB event cap with no error anywhere; locally it spent the
 * model's context on a page's choice of padding. Everything else rendered here
 * is already bounded (page text, 80 elements, 200 chars per attribute from the
 * snapshot script), so these two lines were the whole exposure.
 *
 * Truncated, not refused -- the opposite of what #594 does to the identity
 * fields, and for the opposite reason: those are branched on, where a shortened
 * URL names a different page; these are prose the model reads, where a
 * shortened title beats a dropped snapshot. Marked visibly either way.
 *
 * Two numbers: 2048 is generous for a title and too small for a URL the model
 * copies back into browser_navigate (Maps polylines, OAuth callbacks). The URL
 * cap matches the sidecar's `maxWirePageURL`, so a URL that survives the wire
 * is not cut in the text.
 */
const MAX_RENDERED_TITLE = 2048;
const MAX_RENDERED_URL = 4096;
/**
 * Everything else a page chooses that a browser reply then carries: a
 * `browser_evaluate` result and the message a thrown Error fills. Same failure,
 * same marker, a bigger number because the model asks `browser_evaluate` for a
 * value rather than for prose. `maxPageControlledReply` in the sidecar.
 */
const MAX_PAGE_CONTROLLED_REPLY = 20000;

/**
 * Cut a page-controlled line for the rendering and say so in place.
 *
 * The marker joins the SAME line, directly after the value, with no leading
 * space, and reuses the grammar and quantity the page-text cut already uses
 * (characters REMOVED). `truncateRendered` in sidecar/browser_snapshot.go is
 * this function; the golden parity test fails if the two ever word it
 * differently.
 */
function truncateMarked(value: string, limit: number): string {
  if (limit <= 0) return '';
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  return `${chars.slice(0, limit).join('')}... (${chars.length - limit} chars truncated)`;
}

/**
 * `truncateMarked` for a value that must also be ONE LINE: the `Page:` and
 * `URL:` lines. The count is taken after the strip, so it reports what was cut
 * from the one-line value rather than from the page's original.
 *
 * Deliberately NOT used for a `browser_evaluate` result or an error blob: those
 * are legitimately multi-line, and stripping them would glue every line of a
 * document together - a change to what the model reads with nothing to do with
 * capping it.
 */
function truncateRendered(value: string, limit: number): string {
  return truncateMarked(stripControlChars(value), limit);
}

/**
 * Prepare a page-controlled value for a single LINE of the rendering: control
 * characters out, then cut to `limit` code points.
 *
 * The strip is the rule the sidecar's `truncateURL` applies, for the same
 * reason. These fields are single-line BY CONSTRUCTION - a title, a label, an
 * element's collapsed text - so a newline in one is a page writing a line of
 * the rendering: a title containing a newline plus "URL: ..." produced a
 * second, forged `URL:` line, and an `aria-label` carrying a newline forged an
 * element line, inside a block whose every line the model reads as ours.
 *
 * SCOPE, stated because it is easy to over-read. It covers the title, the URL
 * line, the attributes and the element text, and only the C0 range plus DEL:
 * U+0085, U+2028 and U+2029 survive, so a consumer that treats those as line
 * breaks sees more lines than the formatter wrote. That is deliberate - both
 * formatters emit them identically, so removing them would be a second rule to
 * keep in step for a reader nothing here has - and the `--- Page Text ---`
 * block is legitimately multi-line and is not stripped at all, so a page can
 * still put something that reads like a section header or an `[id]` line into
 * its own body text. Nothing escapes the untrusted block either way; what this
 * buys is that the lines the FORMATTER writes are the formatter's.
 *
 * `renderedValue` in sidecar/browser_snapshot.go is this function.
 */
function renderedValue(value: string, limit: number): string {
  const chars = Array.from(stripControlChars(value));
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('');
}

/**
 * Replace every run of C0 controls and DEL with ONE space.
 *
 * Replaced rather than deleted, and that matters: a multi-line
 * `aria-label="Send\nnow"` is ordinary authoring, and deleting the newline
 * glues the words into "Sendnow". A space is also what the snapshot script
 * already does to the whitespace it collapses, so this is the same rule
 * reaching the characters that rule does not match. Only runs of CONTROL
 * characters collapse: a value with no control character comes back unchanged.
 *
 * `stripControlChars` in sidecar/browser_snapshot.go is this function.
 */
function stripControlChars(value: string): string {
  let out = '';
  let inRun = false;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      if (!inRun) { out += ' '; inRun = true; }
      continue;
    }
    inRun = false;
    out += ch;
  }
  return out;
}

/**
 * The LLM-facing rendering of a snapshot.
 *
 * Exported for `snapshot-format-parity.test.ts` only, which renders the same
 * input through this and through the Go formatter's golden output and compares
 * them byte for byte. #592 kept this text byte-identical because all 100
 * webapp-templates are written against it; nothing but a test should call this.
 */
export function formatSnapshot(snap: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`Page: ${truncateRendered(snap.title, MAX_RENDERED_TITLE)}`);
  lines.push(`URL: ${truncateRendered(snap.url, MAX_RENDERED_URL)}`);
  lines.push('');
  lines.push('--- Page Text ---');
  const text = Array.from(snap.text);
  lines.push(text.length > MAX_PAGE_TEXT ? text.slice(0, MAX_PAGE_TEXT).join('') : snap.text);
  if (text.length > MAX_PAGE_TEXT) {
    lines.push(`... (${text.length - MAX_PAGE_TEXT} chars truncated)`);
  }
  lines.push('');

  if (snap.elements.length > 0) {
    // Prioritize: inputs/textboxes/buttons first, then cap repeated roles.
    // Elements with UNIQUE aria-labels are always shown (they're distinct actions).
    // Elements that share an aria-label (e.g. 50 star toggles) are capped.
    // This prevents repetitive lists from hiding important action buttons like Send.

    // Pre-count aria-label frequency to identify repeated vs unique labels
    const labelFreq = new Map<string, number>();
    for (const el of snap.elements) {
      const label = el.attrs['aria-label'];
      if (label) labelFreq.set(label, (labelFreq.get(label) || 0) + 1);
    }

    const roleCounts = new Map<string, number>();
    const shown: typeof snap.elements = [];
    const deferred: typeof snap.elements = [];

    for (const el of snap.elements) {
      const role = el.attrs.role || el.tag;
      const count = roleCounts.get(role) || 0;
      // Always include high-value elements (inputs, textboxes, contenteditable, buttons)
      const isHighValue = el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select'
        || el.tag === 'button'
        || el.attrs.contenteditable === 'true' || el.attrs.role === 'textbox';
      // Elements with a unique aria-label are distinct actions (e.g. Send, Attach, Delete)
      const hasUniqueLabel = el.attrs['aria-label'] && (labelFreq.get(el.attrs['aria-label']) || 0) === 1;
      if (isHighValue || hasUniqueLabel) {
        shown.push(el);
      } else if (count < MAX_SAME_ROLE) {
        shown.push(el);
        roleCounts.set(role, count + 1);
      } else {
        deferred.push(el);
      }
    }

    // Fill remaining budget with deferred elements
    const budget = MAX_ELEMENTS - shown.length;
    if (budget > 0) {
      shown.push(...deferred.slice(0, budget));
    }

    // Sort by original ID order so positions make sense
    shown.sort((a, b) => a.id - b.id);

    // Highlight key interactive elements at the top so the LLM finds them immediately
    const keyInputs = shown.filter(el =>
      el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select'
      || el.attrs.contenteditable === 'true' || el.attrs.role === 'textbox'
    );
    const keyButtons = shown.filter(el =>
      (el.tag === 'button' || el.attrs.role === 'button') && el.attrs['aria-label']
    );
    if (keyInputs.length > 0 || keyButtons.length > 0) {
      lines.push('--- Key Elements ---');
      for (const el of keyInputs) {
        const label = el.attrs['aria-label'] || el.attrs.placeholder || el.attrs.name || el.tag;
        lines.push(`[${el.id}] INPUT: ${renderedValue(label, MAX_ELEMENT_ATTR)}${el.attrs.contenteditable ? ' (contenteditable)' : ''}`);
      }
      for (const el of keyButtons) {
        lines.push(`[${el.id}] BUTTON: ${renderedValue(el.attrs['aria-label']!, MAX_ELEMENT_ATTR)}`);
      }
      lines.push('');
    }

    lines.push(`--- Interactive Elements (${shown.length}/${snap.elements.length}) ---`);
    for (const el of shown) {
      const attrParts: string[] = [];
      const attr = (key: string) => renderedValue(el.attrs[key]!, MAX_ELEMENT_ATTR);
      if (el.attrs.name) attrParts.push(`name="${attr('name')}"`);
      if (el.attrs.placeholder) attrParts.push(`placeholder="${attr('placeholder')}"`);
      if (el.attrs.type) attrParts.push(`type="${attr('type')}"`);
      if (el.attrs.href) attrParts.push(`href="${renderedValue(el.attrs.href, MAX_ELEMENT_HREF)}"`);
      if (el.attrs['aria-label']) attrParts.push(`aria-label="${attr('aria-label')}"`);
      if (el.attrs.role) attrParts.push(`role="${attr('role')}"`);
      if (el.attrs.contenteditable) attrParts.push(`contenteditable="${attr('contenteditable')}"`);
      if (el.attrs['data-testid']) attrParts.push(`data-testid="${attr('data-testid')}"`);
      if (el.attrs.iframe) attrParts.push(`iframe="${attr('iframe')}"`);

      const textStr = el.text ? ` ${JSON.stringify(renderedValue(el.text, MAX_ELEMENT_TEXT))}` : '';
      const attrStr = attrParts.length > 0 ? ' ' + attrParts.join(' ') : '';
      lines.push(`[${el.id}] ${el.tag}${textStr}${attrStr}`);
    }
    if (snap.elements.length > shown.length) {
      lines.push(`(${snap.elements.length - shown.length} repeated list items hidden. All inputs, buttons, and textboxes are shown above.)`);
    }
  } else {
    lines.push('(no interactive elements found)');
  }

  return lines.join('\n');
}

// --- Browser Tool Implementations ---

/**
 * Resolve which browser stack serves this call and log the decision. Thin
 * wrapper over the shared resolver so each call site names only its tool.
 */
function resolveBrowserTarget(params: Record<string, unknown>, tool: string): string | null {
  return resolveToolTarget(params.target, 'browser', tool);
}

/**
 * Bind a reviewed browser call to the surface it was reviewed on (#602).
 *
 * #495 bound an approval to the reviewed snapshot so that what the user
 * approved is what happens, and `createBrowserTools` -- the background agent's
 * set -- sets a guard on every one of its tools. The main registry set one only
 * on `browser_upload_file`, and `ApprovalManager.createRequest` falls back to
 * `() => true` when a gated tool has none, so `browser_click`, `browser_type`
 * and `browser_hover` had no binding at all: exactly the tools that act on the
 * reviewed surface.
 *
 * THE ASYMMETRY WAS NOT A COPY-PASTE OMISSION, which is why this is not the
 * background set's guard. Every tool there is bound to one `BrowserController`
 * and can only run locally. These tools are dual-routed: when
 * `resolveBrowserTarget` finds a sidecar -- named in `target`, or chosen by
 * `autoTargetForCapability` with nothing named -- the call runs on THAT
 * browser, and the local controller's epoch says nothing about it. On a
 * sidecar-only machine the local controller is never connected, so the
 * background set's guard would refuse every remote browser call outright.
 *
 * So the routing decision is made ONCE, here, at review time -- the same
 * moment and the same async context the tool would have resolved it in -- and
 * never again from inside the returned closure. Re-resolving at execution time
 * would read a live sidecar inventory minutes or hours later, and through an
 * `AsyncLocalStorage` machine scope that is absent on the deferred executor's
 * context, so the two answers could differ with nothing having changed. (The
 * same reasoning `pebble-narration.ts` gives for not calling the router off the
 * tool path.) A router that throws degrades to the unbound guard rather than to
 * a dead approval: `execute` will refuse the call itself, with a reason.
 *
 * REMAINING GAP, deliberate and recorded: a reviewed REMOTE call is still
 * unbound. The sidecar has its own `elemGen` and its own document checks at use
 * time, but nothing in this process can read them synchronously, and the
 * arguments -- including `target` -- are already compared byte for byte by
 * `getUiExecutionRegistry`.
 */
function browserCallGuard(
  tool: string,
  opts: { bindDocument?: boolean } = {},
): (params: Record<string, unknown>) => (() => boolean) {
  return (params) => {
    let reviewedRoute: string | null;
    try {
      reviewedRoute = resolveBrowserTarget(params, tool);
    } catch {
      // Fails CLOSED, matching `createRequest`'s own catch ("a failed subject
      // capture must not create an executable approval"). The only thing that
      // throws here is a MachineScope refusing the dispatch, and the deferred
      // executor carries no scope -- so `execute` would re-resolve without the
      // fence and run the call the scope refused.
      return () => false;
    }
    // A LAZY CONNECTION IS NOT A MISSING SURFACE. `navigate`, `scroll`,
    // `press_key` and `evaluate` all start with `ensureConnected` and need no
    // prior snapshot, so on a cold daemon they are reviewed with nothing
    // connected and connect when they run. Requiring a live connection at
    // review for those produced a card that was already dead: the user clicked
    // Approve and got "its original UI session or reviewed subject is no
    // longer available" for a call that would have worked. The
    // element-addressed tools are the opposite -- they cannot work without the
    // snapshot that minted their ids, so for them a cold browser at review
    // really does mean nothing was reviewed.
    const mayConnectLazily = !opts.bindDocument;
    const local = reviewedRoute ? null : browser.captureApprovalGuard(mayConnectLazily, opts);
    return () => {
      // The ROUTE is compared, never used to pick one. Reviewed local and
      // executed remote is a change of machine, not just of surface: the card
      // named element [5] from the local snapshot, and id 5 on the sidecar is
      // a different element. Re-resolving here is safe precisely because the
      // answer is only ever tested for equality -- an absent machine scope or
      // a sidecar that connected in between fails the approval closed instead
      // of silently retargeting it.
      let nowRoute: string | null;
      try {
        nowRoute = resolveBrowserTarget(params, tool);
      } catch {
        return false;
      }
      if (nowRoute !== reviewedRoute) return false;
      // Remote: nothing in this process holds the reviewed surface. The
      // sidecar runs its own document and generation checks at use time, and
      // the arguments (including `target`) are already compared byte for byte
      // by `getUiExecutionRegistry`.
      return local ? local() : true;
    };
  };
}

/**
 * Say when a remote read reached a page and still got no site playbook.
 *
 * #583 was invisible for exactly this reason: a sidecar-routed browser silently
 * resolved no playbook at all, the tools looked fine, and the only way to learn
 * it was to read the code -- the same class of quiet failure as #574, where a
 * refused hotkey registration reported success.
 *
 * TWO reasons, because there are two ways to get here and they call for
 * different actions. `no_page_identity` means the reply carried no confirmed URL
 * at all, which for a working sidecar means one too old to send it: upgrade it.
 * `url_refused` means a URL did arrive and this daemon's own policy would not
 * resolve it -- a `data:` or `about:blank` document, one over the length cap, or
 * one carrying a control character -- which is a page doing something odd, or a
 * sidecar misbehaving, and is worth seeing rather than guessing at.
 *
 * The REASON is logged and the URL is NOT, on either branch. A refused URL is by
 * definition the value that was over-long or carried a control character, so it
 * is precisely the one that must not be pasted into a log line.
 *
 * Nothing is logged when the call never reached a page (`no_reply`): the
 * dispatch already logged why, and the model is being handed that message, so a
 * second line about a playbook would be noise. Nothing is logged either when the
 * URL was fine and simply has no template -- that is almost every page.
 */
function reportSkippedPlaybook(tool: string, target: string, read: SidecarPageRead & {
  why: 'confirmed' | 'no_reply' | 'no_page_identity';
}): void {
  if (read.why === 'no_reply') return;
  // The same validator the delivery uses, asked the same question. Calling it
  // twice is free and keeps the alternative -- a reason code plumbed back out of
  // the delivery -- from existing.
  const reason = read.pageUrl === null ? 'no confirmed page URL (an older sidecar does not send one)'
    : usablePageUrl(read.pageUrl) === null ? 'a confirmed page URL this daemon will not resolve'
    : null;
  if (!reason) return;
  console.log(`[browser] ${tool} on sidecar "${target}" returned ${reason}, so no site playbook was resolved.`);
}

/**
 * ONE RULE for every browser tool below (#572): the site playbook is selected
 * from a URL THE BROWSER CONFIRMED, and from nothing else.
 *
 * Not from the rendered snapshot, which is a page. Not from the URL that was
 * REQUESTED either, tempting as that looks -- it is the model's string rather
 * than the page's, but a redirect makes it false, open redirects are ordinary on
 * the very hosts templates are written for, and the trailer then states "You are
 * now on <that host>" OUTSIDE the untrusted block over a page that is not it.
 * Naming the wrong site with authority is worse than naming none.
 *
 * Locally that URL is `PageSnapshot.browserUrl`, from Chrome's frame tree.
 * Remotely it is the sidecar's `page_url` (#583), from the same frame tree on
 * the other machine, and it arrives only with the `loader_id` that proves it
 * names the document the text came from. Either one can still be absent -- a
 * lost race locally, an older sidecar remotely -- and absent means null, which
 * means no playbook and a log line saying so, never a fallback to the request.
 */

export const browserNavigateTool: ToolDefinition = {
  name: 'browser_navigate',
  captureApprovalGuard: browserCallGuard('browser_navigate'),
  description: 'Navigate the browser to a URL. Returns page text content and a list of interactive elements with [id] numbers you can reference in browser_click and browser_type. Optionally specify a "target" sidecar to use a remote browser. By default the browser opens visibly so the user can watch and interact; set "headless" to true to run it hidden in the background (useful for research, or when the user is focused on something else and a popping browser window would be intrusive).',
  category: 'browser',
  parameters: {
    url: {
      type: 'string',
      description: 'The URL to navigate to',
      required: true,
    },
    headless: {
      type: 'boolean',
      description: 'Run the browser hidden in the background instead of opening a visible window the user can see and interact with. Default false (visible). The mode is set when the browser launches; switching it while a browser is already open relaunches it.',
      required: false,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    // The scheme allowlist applies to sidecar browsers too: the sidecar has no
    // check of its own, and its file: is the file system of the machine it
    // runs on. The local path checks again in BrowserController.navigate.
    let url: string;
    try {
      url = checkNavigationUrl(params.url as string);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const target = resolveBrowserTarget(params, 'browser_navigate');
    if (target) {
      const read = await routeBrowserReadToSidecar(target, 'browser_navigate',
        { url, headless: params.headless });
      reportSkippedPlaybook('browser_navigate', target, read);
      return globalWebappTemplateDelivery.withInstructions(read.text, read.pageUrl);
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const snap = await browser.navigate(url);
      return globalWebappTemplateDelivery.withInstructions(formatSnapshot(snap), snap.browserUrl);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  description: 'Get the current page content and interactive elements. Each element has an [id] you can use with browser_click and browser_type. Use this after clicking or typing to see what changed.',
  category: 'browser',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_snapshot');
    if (target) {
      const read = await routeBrowserReadToSidecar(target, 'browser_snapshot', {});
      reportSkippedPlaybook('browser_snapshot', target, read);
      return globalWebappTemplateDelivery.withInstructions(read.text, read.pageUrl);
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const snap = await browser.snapshot();
      return globalWebappTemplateDelivery.withInstructions(formatSnapshot(snap), snap.browserUrl);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  captureApprovalGuard: browserCallGuard('browser_click', { bindDocument: true }),
  description: 'Click an interactive element on the page by its [id] from the last browser_navigate or browser_snapshot. The [id]s expire: scrolling, a paging key, or the page replacing or moving the element retires them, and this refuses rather than clicking the wrong place - take a fresh browser_snapshot when it says so. Supports right-click (button: "right", opens context menus) and double-click (double: true).',
  category: 'browser',
  parameters: {
    element_id: {
      type: 'number',
      description: 'The [id] of the element to click (from browser_snapshot)',
      required: true,
    },
    button: {
      type: 'string',
      description: 'Mouse button: "left" (default) or "right" for a context-menu click',
      required: false,
    },
    double: {
      type: 'boolean',
      description: 'Double-click instead of single click (default: false)',
      required: false,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_click');
    if (target) {
      return routeToSidecar(target, 'browser_click', {
        element_id: params.element_id,
        button: params.button,
        double: params.double,
      }, 'browser');
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      return await browser.click(params.element_id as number, {
        button: params.button === 'right' ? 'right' : 'left',
        double: (params.double as boolean) ?? false,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserHoverTool: ToolDefinition = {
  name: 'browser_hover',
  captureApprovalGuard: browserCallGuard('browser_hover', { bindDocument: true }),
  description: 'Hover the mouse over an element by its [id]. Use this to reveal hover-only UI (message action toolbars, dropdown triggers, tooltips). After hovering, take a browser_snapshot to see the revealed elements, then click them without moving the mouse elsewhere first.',
  category: 'browser',
  parameters: {
    element_id: {
      type: 'number',
      description: 'The [id] of the element to hover over (from browser_snapshot)',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_hover');
    if (target) {
      return routeToSidecar(target, 'browser_hover', { element_id: params.element_id }, 'browser');
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      return await browser.hover(params.element_id as number);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserPressKeyTool: ToolDefinition = {
  name: 'browser_press_key',
  captureApprovalGuard: browserCallGuard('browser_press_key'),
  description: 'Press a key or key combination in the browser page (sent to the focused element). Examples: "Enter", "Escape", "Tab", "ArrowDown", "Ctrl+K", "Shift+Enter", "Ctrl+Shift+M". Use for in-app keyboard shortcuts, menu navigation, and committing edits. Note: browser-reserved shortcuts (Ctrl+N, Ctrl+T, Ctrl+1-9) are intercepted by Chrome and never reach the page — use in-page UI for those actions instead. PageUp, PageDown, Home and End scroll the page, which retires every element [id]: snapshot again before using one.',
  category: 'browser',
  parameters: {
    key: {
      type: 'string',
      description: 'Key or combo to press, e.g. "Enter", "Escape", "Ctrl+K", "Shift+Enter"',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_press_key');
    if (target) {
      return routeToSidecar(target, 'browser_press_key', { key: params.key }, 'browser');
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      return await browser.pressKey(params.key as string);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserTypeTool: ToolDefinition = {
  name: 'browser_type',
  captureApprovalGuard: browserCallGuard('browser_type', { bindDocument: true }),
  description: 'Type text into an input element by its [id]. IMPORTANT: by default this REPLACES the element\'s existing content (it is cleared first). Set append to true to keep existing content and add at the end. Set submit to true to press Enter after typing (useful for search forms).',
  category: 'browser',
  parameters: {
    element_id: {
      type: 'number',
      description: 'The [id] of the input element to type into (from browser_snapshot)',
      required: true,
    },
    text: {
      type: 'string',
      description: 'The text to type',
      required: true,
    },
    submit: {
      type: 'boolean',
      description: 'Press Enter after typing (default: false)',
      required: false,
    },
    append: {
      type: 'boolean',
      description: 'Keep the element\'s existing content and insert at the end, instead of replacing it (default: false)',
      required: false,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_type');
    if (target) {
      return routeToSidecar(target, 'browser_type', {
        element_id: params.element_id,
        text: params.text,
        submit: params.submit,
        append: params.append,
      }, 'browser');
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      return await browser.type(
        params.element_id as number,
        params.text as string,
        (params.submit as boolean) ?? false,
        (params.append as boolean) ?? false,
      );
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current browser page. The image is sent directly to the AI for visual analysis.',
  category: 'browser',
  parameters: {
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_screenshot');
    if (target) {
      return routeToSidecar(target, 'browser_screenshot', {}, 'browser');
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const { base64, mimeType } = await browser.screenshotBuffer();
      return {
        content: [
          { type: 'text' as const, text: 'Browser screenshot captured.' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64 } },
        ],
      } satisfies ToolResult;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserUploadFileTool: ToolDefinition = {
  name: 'browser_upload_file',
  description: 'Upload a file to a file input on the page. Use this after clicking an upload/attach button that triggers a file picker dialog. This bypasses the native file picker and sets the file directly via CDP.',
  category: 'browser',
  parameters: {
    file_path: {
      type: 'string',
      description: 'Absolute path to the file to upload',
      required: true,
    },
    selector: {
      type: 'string',
      description: 'CSS selector for the file input element (default: first input[type="file"] on the page)',
      required: false,
    },
  },
  /**
   * The card IS the review (#507), and for an upload the three things a person
   * needs are: which file, how big, and who receives it. `rawUiGate` already
   * forces a click on every call, but its sentence is generic -- and because a
   * tool's own intent REPLACES it (tool-action-map.ts), the "effect unknown"
   * warning has to be restated here rather than lost.
   *
   * Synchronous, as every authorityGate must be, so the origin comes from the
   * URL the browser last reported rather than a CDP round trip; `uploadFile`
   * re-reads it authoritatively and refuses a cross-origin move. A path the
   * policy will refuse returns null: `execute` does the refusing, with the
   * reason, and a doomed call gets no card of its own.
   */
  authorityGate: (params) => {
    let real: string;
    let size: number;
    try {
      real = checkUploadPath(String(params.file_path ?? ''));
      size = Number(statSync(real).size);
    } catch {
      return null;
    }
    const url = browser.lastKnownPageUrl();
    // A page that cannot receive a file at all: say so on the card rather than
    // asking for a click on "Send a local file to null". `execute` refuses it
    // anyway; this stops the user spending a decision on it.
    const wrongPage = url === null ? 'no page reported by the browser yet' : uploadTargetRefusal(url);
    if (wrongPage) {
      return {
        actionCategory: 'write_data',
        confirm: 'always',
        intent: `This upload will be REFUSED and needs no approval: ${wrongPage} Requested file: ${forCard(real)}`,
      };
    }
    // Through forCard as well: the origin comes from the browser, but it lands
    // mid-sentence, which is the position that can forge an ending.
    const origin = forCard(pageOrigin(url!) ?? url!, 120);
    return {
      actionCategory: 'write_data',
      confirm: 'always',
      // The path goes LAST and in full: it is the value being approved, and
      // nothing after it can pose as the rest of the sentence.
      intent: `Send a local file to ${origin} (${formatBytes(size)}). The page receives the file's contents and can `
        + `forward them anywhere; check that this is the right page and the right file: ${forCard(real)}`,
    };
  },
  /**
   * Bind what was reviewed. Without this the approval manager falls back to
   * `() => true` and an upload has no subject binding at all, so a click could
   * be spent after a reconnect adopted a different tab.
   *
   * Three parts, all of which must still hold at execution: the controller's own
   * epoch guard (the same one every other reviewed browser tool uses, which
   * catches a reconnect or a dropped request guard), the file's identity, and the
   * origin the card named.
   */
  captureApprovalGuard: (params) => {
    const epochHolds = browser.captureApprovalGuard();
    const reviewedOrigin = (() => {
      const url = browser.lastKnownPageUrl();
      return url ? pageOrigin(url) : null;
    })();
    let fingerprint: string | null = null;
    try {
      const real = checkUploadPath(String(params.file_path ?? ''));
      const st = statSync(real);
      fingerprint = `${real}\0${st.dev}\0${st.ino}\0${st.size}\0${st.mtimeMs}`;
    } catch { /* refused or gone: the guard below fails it */ }
    return () => {
      if (!epochHolds() || fingerprint === null) return false;
      try {
        const real = checkUploadPath(String(params.file_path ?? ''));
        const st = statSync(real);
        if (`${real}\0${st.dev}\0${st.ino}\0${st.size}\0${st.mtimeMs}` !== fingerprint) return false;
      } catch {
        return false;
      }
      const url = browser.lastKnownPageUrl();
      return reviewedOrigin === (url ? pageOrigin(url) : null);
    };
  },
  execute: async (params) => {
    // No sidecar route exists for uploads, so the generic "use a sidecar"
    // guidance would send the agent in circles - say so explicitly.
    if (isLocalBrowserDisabled()) {
      return 'Error: browser_upload_file requires the LOCAL browser, which is disabled on this machine (browser.local: false), and file upload has no sidecar route yet. This action is unavailable - do NOT retry.';
    }
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      return await browser.uploadFile(
        params.file_path as string,
        params.selector as string | undefined,
      );
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserScrollTool: ToolDefinition = {
  name: 'browser_scroll',
  captureApprovalGuard: browserCallGuard('browser_scroll'),
  description: 'Scroll the page up or down. Use this when you need to see content below the fold. Scrolling RETIRES every element [id] from the last snapshot, because their positions have moved: take a browser_snapshot afterwards and use the fresh [id]s.',
  category: 'browser',
  parameters: {
    direction: {
      type: 'string',
      description: 'Scroll direction: "down" or "up" (default: "down")',
      required: false,
    },
    amount: {
      type: 'number',
      description: 'Pixels to scroll (default: one viewport height). Use larger values like 2000 to jump further.',
      required: false,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_scroll');
    if (target) {
      return routeToSidecar(target, 'browser_scroll', {
        direction: params.direction,
        amount: params.amount,
      }, 'browser');
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const direction = (params.direction as string) === 'up' ? 'up' : 'down';
      const amount = params.amount as number | undefined;
      return await browser.scroll(direction, amount);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserEvaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  captureApprovalGuard: browserCallGuard('browser_evaluate'),
  description: 'Execute JavaScript in the browser page context. Use this for advanced interactions when the standard tools are not enough. Long results are truncated, so return the value you need rather than a whole document.',
  category: 'browser',
  parameters: {
    expression: {
      type: 'string',
      description: 'JavaScript expression to evaluate in the page. For complex operations, wrap in an IIFE: (() => { ... })()',
      required: true,
    },
    target: {
      type: 'string',
      description: 'Sidecar name or ID to use a remote browser (omit for local)',
      required: false,
    },
  },
  execute: async (params) => {
    const target = resolveBrowserTarget(params, 'browser_evaluate');
    if (target) {
      return routeToSidecar(target, 'browser_evaluate', { expression: params.expression }, 'browser');
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const result = await browser.evaluate(params.expression as string);
      if (result === undefined || result === null) return '(no return value)';
      // Capped for the reason the snapshot's title line is (#597): the VALUE is
      // the page's and was unbounded, so a megabyte return filled the model's
      // context here and, on the sidecar's identical path, got the whole reply
      // dropped at the 2 MB cap with no error. Marked but NOT stripped: an
      // evaluate result is routinely `innerText` or pretty-printed JSON, and
      // flattening those would mangle every ordinary answer.
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return truncateMarked(text, MAX_PAGE_CONTROLLED_REPLY);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${truncateMarked(message, MAX_PAGE_CONTROLLED_REPLY)}`;
    }
  },
};

/**
 * Non-browser tools (terminal, file operations).
 * Safe to share across multiple agent services — they are stateless.
 */
export const NON_BROWSER_TOOLS: ToolDefinition[] = [
  runCommandTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  getClipboardTool,
  setClipboardTool,
  captureScreenTool,
  getSystemInfoTool,
  listSidecarsTool,
];

/**
 * All built-in tools.
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  ...NON_BROWSER_TOOLS,
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserHoverTool,
  browserPressKeyTool,
  browserScrollTool,
  browserUploadFileTool,
  browserEvaluateTool,
  browserScreenshotTool,
  ...DESKTOP_TOOLS,
  ...UI_TOOLS,
  ...SKILL_TOOLS,
];

/**
 * Create browser tools bound to a specific BrowserController.
 * Used to give the background agent its own browser instance
 * while keeping tool definitions identical to the main agent's.
 */
export function createBrowserTools(ctrl: BrowserController): ToolDefinition[] {
  // Each bound tool set serves its own LLM conversation (e.g. a background
  // agent), so it gets its own template-delivery state — sharing the global
  // agent's would let one conversation's browsing suppress the playbook in
  // the other's history.
  const templateDelivery = new WebappTemplateDelivery();
  const tools: ToolDefinition[] = [
    {
      name: 'browser_navigate',
      description: browserNavigateTool.description,
      category: 'browser',
      parameters: browserNavigateTool.parameters,
      execute: async (params) => {
        try {
          const snap = await ctrl.navigate(params.url as string);
          return templateDelivery.withInstructions(formatSnapshot(snap), snap.browserUrl);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_snapshot',
      description: browserSnapshotTool.description,
      category: 'browser',
      parameters: browserSnapshotTool.parameters,
      execute: async () => {
        try {
          const snap = await ctrl.snapshot();
          return templateDelivery.withInstructions(formatSnapshot(snap), snap.browserUrl);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_click',
      description: browserClickTool.description,
      category: 'browser',
      parameters: browserClickTool.parameters,
      execute: async (params) => {
        try {
          return await ctrl.click(params.element_id as number, {
            button: params.button === 'right' ? 'right' : 'left',
            double: (params.double as boolean) ?? false,
          });
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_type',
      description: browserTypeTool.description,
      category: 'browser',
      parameters: browserTypeTool.parameters,
      execute: async (params) => {
        try {
          return await ctrl.type(
            params.element_id as number,
            params.text as string,
            (params.submit as boolean) ?? false,
            (params.append as boolean) ?? false,
          );
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_hover',
      description: browserHoverTool.description,
      category: 'browser',
      parameters: browserHoverTool.parameters,
      execute: async (params) => {
        try {
          return await ctrl.hover(params.element_id as number);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_press_key',
      description: browserPressKeyTool.description,
      category: 'browser',
      parameters: browserPressKeyTool.parameters,
      execute: async (params) => {
        try {
          return await ctrl.pressKey(params.key as string);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_scroll',
      description: browserScrollTool.description,
      category: 'browser',
      parameters: browserScrollTool.parameters,
      execute: async (params) => {
        try {
          const direction = (params.direction as string) === 'up' ? 'up' : 'down';
          const amount = params.amount as number | undefined;
          return await ctrl.scroll(direction, amount);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_evaluate',
      description: browserEvaluateTool.description,
      category: 'browser',
      parameters: browserEvaluateTool.parameters,
      execute: async (params) => {
        try {
          const result = await ctrl.evaluate(params.expression as string);
          if (result === undefined || result === null) return '(no return value)';
          return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'browser_screenshot',
      description: browserScreenshotTool.description,
      category: 'browser',
      parameters: browserScreenshotTool.parameters,
      execute: async () => {
        try {
          const { base64, mimeType } = await ctrl.screenshotBuffer();
          return {
            content: [
              { type: 'text' as const, text: 'Browser screenshot captured.' },
              { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64 } },
            ],
          } satisfies ToolResult;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
  // Every tool here is bound to THIS controller and can only run locally, so
  // the guard is the controller's own -- no routing term, unlike the main
  // registry's `browserCallGuard`.
  //
  // The element-addressed three bind the SURFACE as well (#602): an approval
  // reviewed against one snapshot must not execute against another, and a
  // snapshot of the same document re-numbers every id while the loaderId holds.
  const elementAddressed = new Set(['browser_click', 'browser_type', 'browser_hover']);
  for (const tool of tools) {
    const bindDocument = elementAddressed.has(tool.name);
    // Same rule as the main registry: everything that connects lazily may be
    // reviewed against a cold browser, and only the element-addressed tools
    // genuinely require the snapshot that minted their ids.
    tool.captureApprovalGuard = () => ctrl.captureApprovalGuard(!bindDocument, { bindDocument });
  }
  return tools;
}
