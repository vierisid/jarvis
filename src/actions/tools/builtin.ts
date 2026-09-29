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
import { routeToSidecar, autoTargetForCapability, resolveToolTarget } from './sidecar-route.ts';
import { WebappTemplateDelivery, globalWebappTemplateDelivery } from './webapp-template-injection.ts';
import { listSidecarsTool } from './sidecar-list.ts';
import { DESKTOP_TOOLS } from './desktop.ts';
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
    if (auto) return routeToSidecar(auto, 'capture_screen', {}, 'screenshot');
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const base64 = localCaptureScreen();
      return JSON.stringify({ type: 'inline', mime_type: 'image/png', data: base64 });
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

const MAX_PAGE_TEXT = 2000;   // chars of visible page text
const MAX_ELEMENTS = 80;      // interactive elements shown to LLM
const MAX_SAME_ROLE = 15;     // max elements with the same role (e.g., gridcell)

function formatSnapshot(snap: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`Page: ${snap.title}`);
  lines.push(`URL: ${snap.url}`);
  lines.push('');
  lines.push('--- Page Text ---');
  lines.push(snap.text.slice(0, MAX_PAGE_TEXT));
  if (snap.text.length > MAX_PAGE_TEXT) {
    lines.push(`... (${snap.text.length - MAX_PAGE_TEXT} chars truncated)`);
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
        lines.push(`[${el.id}] INPUT: ${label}${el.attrs.contenteditable ? ' (contenteditable)' : ''}`);
      }
      for (const el of keyButtons) {
        lines.push(`[${el.id}] BUTTON: ${el.attrs['aria-label']}`);
      }
      lines.push('');
    }

    lines.push(`--- Interactive Elements (${shown.length}/${snap.elements.length}) ---`);
    for (const el of shown) {
      const attrParts: string[] = [];
      if (el.attrs.name) attrParts.push(`name="${el.attrs.name}"`);
      if (el.attrs.placeholder) attrParts.push(`placeholder="${el.attrs.placeholder}"`);
      if (el.attrs.type) attrParts.push(`type="${el.attrs.type}"`);
      if (el.attrs.href) attrParts.push(`href="${el.attrs.href.slice(0, 80)}"`);
      if (el.attrs['aria-label']) attrParts.push(`aria-label="${el.attrs['aria-label']}"`);
      if (el.attrs.role) attrParts.push(`role="${el.attrs.role}"`);
      if (el.attrs.contenteditable) attrParts.push(`contenteditable="${el.attrs.contenteditable}"`);
      if (el.attrs['data-testid']) attrParts.push(`data-testid="${el.attrs['data-testid']}"`);
      if (el.attrs.iframe) attrParts.push(`iframe="${el.attrs.iframe}"`);

      const textStr = el.text ? ` "${el.text.slice(0, 50)}"` : '';
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

export const browserNavigateTool: ToolDefinition = {
  name: 'browser_navigate',
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
      const result = await routeToSidecar(target, 'browser_navigate', { url, headless: params.headless }, 'browser');
      return globalWebappTemplateDelivery.withInstructions(result, params.url as string);
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const snap = await browser.navigate(params.url as string);
      return globalWebappTemplateDelivery.withInstructions(formatSnapshot(snap), params.url as string);
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
      const result = await routeToSidecar(target, 'browser_snapshot', {}, 'browser');
      return globalWebappTemplateDelivery.withInstructions(result);
    }
    if (isLocalBrowserDisabled()) return LOCAL_BROWSER_DISABLED_MSG;
    if (isNoLocalTools()) return LOCAL_DISABLED_MSG;
    try {
      const snap = await browser.snapshot();
      return globalWebappTemplateDelivery.withInstructions(formatSnapshot(snap));
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  description: 'Click an interactive element on the page by its [id] from the last browser_navigate or browser_snapshot. Supports right-click (button: "right", opens context menus) and double-click (double: true).',
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
  description: 'Press a key or key combination in the browser page (sent to the focused element). Examples: "Enter", "Escape", "Tab", "ArrowDown", "Ctrl+K", "Shift+Enter", "Ctrl+Shift+M". Use for in-app keyboard shortcuts, menu navigation, and committing edits. Note: browser-reserved shortcuts (Ctrl+N, Ctrl+T, Ctrl+1-9) are intercepted by Chrome and never reach the page — use in-page UI for those actions instead.',
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
  description: 'Scroll the page up or down. Use this when you need to see content below the fold. After scrolling, use browser_snapshot to see the new content.',
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
  description: 'Execute JavaScript in the browser page context. Use this for advanced interactions when the standard tools are not enough.',
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
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
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
          return templateDelivery.withInstructions(formatSnapshot(snap), params.url as string);
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
          return templateDelivery.withInstructions(formatSnapshot(snap));
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
  for (const tool of tools) {
    tool.captureApprovalGuard = () => ctrl.captureApprovalGuard(tool.name === 'browser_navigate');
  }
  return tools;
}
