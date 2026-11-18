/**
 * The engine's file sandbox (#1154).
 *
 * WHY. The engine runs piece code and CODE steps, workflow-authored code, as
 * the daemon's uid. Without this it can read everything the daemon can: the
 * vault database, the keychain, google-tokens.json, the workflow encryption
 * key, and every other flow's files. A sandboxed engine reads only what a run
 * needs and writes only a private directory of its own.
 *
 * HOW (Linux). The engine is started through `jarvis-sandbox`
 * (sandbox-launcher/, a small static Go binary, since Bun cannot make the
 * Landlock calls before exec), which applies a Landlock ruleset and then
 * execs Bun. Landlock is inherited, so the CODE-step children the engine
 * starts (no-op-code-sandbox.ts) run under the same rules. It needs no
 * privilege and no extra container capability.
 *
 * HOW (macOS). The engine starts under `sandbox-exec` (Seatbelt) with a
 * profile generated from the same allow-list (`seatbeltProfile`): file reads
 * and writes are denied except on the listed paths, and nothing written in the
 * private directory can be executed. File metadata (stat) stays readable
 * everywhere, since module resolution walks parent directories. Children
 * inherit the profile. `sandbox-exec` is deprecated by Apple but ships with
 * every macOS; a self-check at first use (`seatbeltSupport`) makes sure Bun
 * starts under it and that it really denies, and otherwise the setting's
 * fallback applies.
 *
 * WHAT IT ALLOWS (`engineAllowList`):
 *   read-only:  the Bun binary, the engine bundle and its empty bunfig, the
 *               vendored pieces tree (the engine's cwd), the piece search
 *               roots (installed and shared pieces), the run's CODE tree
 *               (`<workflow-codes>/<flowVersionId>`, granted at spawn, so a
 *               warm engine is reused only for the same flow version), and
 *               the system files a process needs (libraries, CA certificates,
 *               DNS and time zone configuration, /proc).
 *   read-write: a private directory created for this engine, which is its
 *               TMPDIR and HOME, and /dev/null.
 * Everything else is denied, the daemon's data folder included. The engine
 * talks to the daemon over TCP (the sandbox API's WebSocket and HTTP) and to a
 * CODE child over an inherited socket pair, so no socket path is needed.
 *
 * WHAT IT DOES NOT COVER: the network (pieces still reach whatever the per-step
 * egress guards allow), connecting to a unix socket that already exists, and,
 * before Linux 6.2 (Landlock ABI 3), truncating a file by path. Before ABI 6
 * the engine can still signal processes outside the sandbox.
 *
 * THE SETTING. `workflows.sandbox` in config.yaml (file-owned, like the
 * artifact paths) or JARVIS_WORKFLOW_SANDBOX:
 *   prefer (default) sandbox when the kernel and the launcher allow it, and
 *                    otherwise run unsandboxed with a warning;
 *   require          refuse to start an engine that cannot be sandboxed;
 *   off              never sandbox.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { sanitizedEnv } from "../../../util/subprocess-env";
import { ENGINE_BUILD_PATHS } from "./build";

export type SandboxMode = "require" | "prefer" | "off";

export const SANDBOX_MODE_ENV = "JARVIS_WORKFLOW_SANDBOX";
/** An operator-supplied launcher binary, instead of the one shipped in sandbox-launcher/dist. */
export const SANDBOX_LAUNCHER_ENV = "JARVIS_SANDBOX_LAUNCHER";
export const DEFAULT_SANDBOX_MODE: SandboxMode = "prefer";

const MODES: readonly SandboxMode[] = ["require", "prefer", "off"];

/**
 * The configured mode: config.yaml's `workflows.sandbox`, else the env var,
 * else `prefer`. An unknown value is never read as `off`: it falls to the
 * next source with a warning.
 */
export function resolveSandboxMode(
  configured: unknown,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): SandboxMode {
  for (const [value, source] of [[configured, "workflows.sandbox"], [env[SANDBOX_MODE_ENV], SANDBOX_MODE_ENV]] as const) {
    if (value === undefined || value === null || value === "") continue;
    const text = typeof value === "string" ? value.trim().toLowerCase() : value;
    if (MODES.includes(text as SandboxMode)) return text as SandboxMode;
    warn(`[engine-sandbox] ignoring ${source}=${JSON.stringify(value)}: expected require, prefer or off`);
  }
  return DEFAULT_SANDBOX_MODE;
}

let configuredMode: SandboxMode | undefined;

/**
 * Set by the daemon at boot from `workflows.sandbox`, so every EngineRuntime
 * it builds (the main one, the prepared dry-run's, the evaluation's) uses the
 * operator's mode without each having to be handed it.
 */
export function configureEngineSandbox(mode: SandboxMode | undefined): void {
  configuredMode = mode;
}

/** The mode an EngineRuntime uses when it is not given one. */
export function defaultSandboxMode(): SandboxMode {
  return configuredMode ?? resolveSandboxMode(undefined);
}

/**
 * One line for the boot log: what engines will run under. Never throws, and
 * warns the way `decideSandbox` would.
 */
export function describeSandbox(mode: SandboxMode, support: () => SandboxSupport = () => detectSandboxSupport()): string {
  if (mode === "off") return "workflow engine sandbox: off (workflows.sandbox). Engines run with the daemon's file access.";
  const s = support();
  if (s.kind === "landlock") return `workflow engine sandbox: Landlock ABI ${s.abi} (${mode}), launcher ${s.launcher}`;
  if (s.kind === "seatbelt") return `workflow engine sandbox: macOS sandbox-exec (${mode})`;
  return mode === "require"
    ? `workflow engine sandbox: UNAVAILABLE and required, so no workflow engine will start: ${s.reason}`
    : `workflow engine sandbox: UNAVAILABLE, engines run unsandboxed (prefer): ${s.reason}`;
}

/** Where the shipped launcher for this platform and architecture lives. */
export function bundledLauncherPath(arch: string = process.arch): string {
  return resolve(ENGINE_BUILD_PATHS.REPO_ROOT, "sandbox-launcher", "dist", `jarvis-sandbox-linux-${arch}`);
}

export type ActiveSandbox =
  | { kind: "landlock"; launcher: string; abi: number }
  | { kind: "seatbelt"; launcher: string };

export type SandboxSupport = ActiveSandbox | { kind: "none"; reason: string };

/** Where macOS keeps sandbox-exec. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const SUPPORT_CACHE = new Map<string, SandboxSupport>();

/**
 * What this machine can do, asked of the launcher itself (`--abi`), so the
 * answer covers the kernel, its lsm= list, and a seccomp profile that blocks
 * the calls. Cached per launcher path for the life of the process: none of
 * them change under a running daemon.
 */
export function detectSandboxSupport(opts: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  arch?: string;
} = {}): SandboxSupport {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const cached = SUPPORT_CACHE.get(SANDBOX_EXEC);
    if (cached) return cached;
    const support = seatbeltSupport();
    SUPPORT_CACHE.set(SANDBOX_EXEC, support);
    return support;
  }
  if (platform !== "linux") {
    return { kind: "none", reason: `no file sandbox for ${platform} yet` };
  }
  const env = opts.env ?? process.env;
  const configured = env[SANDBOX_LAUNCHER_ENV]?.trim();
  if (configured && !isAbsolute(configured)) {
    return { kind: "none", reason: `${SANDBOX_LAUNCHER_ENV}=${JSON.stringify(configured)} is not an absolute path` };
  }
  const launcher = configured || bundledLauncherPath(opts.arch);
  const cached = SUPPORT_CACHE.get(launcher);
  if (cached) return cached;
  const support = probeLauncher(launcher, Boolean(configured));
  SUPPORT_CACHE.set(launcher, support);
  return support;
}

/** Tests only: forget what earlier probes found. */
export function resetSandboxSupportCache(): void {
  SUPPORT_CACHE.clear();
  WARNED.clear();
}

function probeLauncher(launcher: string, configured: boolean): SandboxSupport {
  if (!existsSync(launcher)) {
    return {
      kind: "none",
      reason: configured
        ? `the launcher ${launcher} (${SANDBOX_LAUNCHER_ENV}) does not exist`
        : `the sandbox launcher is not built (${launcher}); build it with \`bun run build:sandbox\` (needs Go)`,
    };
  }
  const probe = spawnSync(launcher, ["--abi"], { encoding: "utf8", timeout: 5_000, env: sanitizedEnv() });
  if (probe.error || probe.status !== 0) {
    const why = probe.error?.message ?? (probe.stderr.trim() || `exit ${probe.status}`);
    return { kind: "none", reason: `the sandbox launcher ${launcher} failed its probe: ${why}` };
  }
  const abi = Number.parseInt(probe.stdout.trim(), 10);
  if (!Number.isInteger(abi) || abi < 1) {
    return {
      kind: "none",
      reason: "this kernel offers no Landlock (Linux 5.13 or later with landlock in its lsm= list, and not blocked by seccomp)",
    };
  }
  return { kind: "landlock", launcher, abi };
}

export class EngineSandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `workflow engine not started: workflows.sandbox is "require" and the engine cannot be sandboxed: ${reason}. ` +
        `Fix that, or set workflows.sandbox to "prefer" to run unsandboxed with a warning.`,
    );
    this.name = "EngineSandboxUnavailableError";
  }
}

const WARNED = new Set<string>();

/**
 * The launcher to start an engine through, or null to start it directly.
 * `require` without support throws; `prefer` without support warns once per
 * reason and runs unsandboxed.
 */
export function decideSandbox(
  mode: SandboxMode,
  support: () => SandboxSupport,
  warn: (message: string) => void = (m) => console.warn(m),
): ActiveSandbox | null {
  if (mode === "off") return null;
  const s = support();
  if (s.kind !== "none") return s;
  if (mode === "require") throw new EngineSandboxUnavailableError(s.reason);
  if (!WARNED.has(s.reason)) {
    WARNED.add(s.reason);
    warn(
      `[engine-sandbox] WARNING: workflow engines run WITHOUT a file sandbox: ${s.reason}. ` +
        `Piece and CODE-step code can read everything the daemon can, its data folder included. ` +
        `Set workflows.sandbox to "require" to refuse instead.`,
    );
  }
  return null;
}

/** What one engine needs to read, besides the system paths. */
export interface EngineSandboxPaths {
  /** The Bun binary the launcher execs (and a CODE step starts again). */
  runtime: string;
  bundlePath: string;
  bunfigPath: string;
  cwd?: string;
  customPiecesPaths?: readonly string[];
  /** The run's CODE tree, `<workflow-codes>/<flowVersionId>`, when it has one. */
  codeTree?: string;
  /** A transpiler cache the engine is allowed to read (host-owned, read-only). */
  transpilerCache?: string;
  /** The engine's own read-write directory. */
  privateDir: string;
}

/**
 * System paths every engine reads: the loader and libraries, CA
 * certificates, name resolution, users and groups (os.userInfo), time zones,
 * and /proc for its own process (reading another process's environ or
 * memory from inside a Landlock domain is refused by Landlock's ptrace
 * rule). A path that does not exist is skipped by the launcher.
 */
export const SYSTEM_READ_ONLY: readonly string[] = Object.freeze([
  "/usr",
  "/lib",
  "/lib64",
  "/lib32",
  "/libx32",
  "/bin",
  "/sbin",
  "/nix/store",
  "/etc/ssl",
  "/etc/pki",
  "/etc/ca-certificates",
  "/etc/crypto-policies",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/resolv.conf",
  "/run/systemd/resolve",
  "/etc/hosts",
  "/etc/host.conf",
  "/etc/nsswitch.conf",
  "/etc/gai.conf",
  "/etc/services",
  "/etc/protocols",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/mime.types",
  "/proc",
  "/sys/devices/system/cpu",
  "/sys/fs/cgroup",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
]);

export const SYSTEM_READ_WRITE: readonly string[] = Object.freeze(["/dev/null"]);

/**
 * The macOS system paths, as the kernel sees them: /etc, /var and /tmp are
 * links into /private, and Seatbelt matches the resolved path. The dyld
 * shared cache and the system frameworks live under /System.
 */
export const SYSTEM_READ_ONLY_DARWIN: readonly string[] = Object.freeze([
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library/Apple",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/run/resolv.conf",
  "/dev",
]);

export function engineAllowList(
  p: EngineSandboxPaths,
  platform: NodeJS.Platform = process.platform,
): { readOnly: string[]; readWrite: string[] } {
  const readOnly = new Set<string>(platform === "darwin" ? SYSTEM_READ_ONLY_DARWIN : SYSTEM_READ_ONLY);
  const add = (path: string | undefined): void => {
    if (path && isAbsolute(path)) readOnly.add(path);
  };
  // The binary itself, not its directory: next to it can be anything (a
  // ~/.bun/bin holding other tools, or the install tree).
  add(realOrSelf(p.runtime));
  add(dirname(p.bundlePath));
  add(p.bunfigPath);
  // The vendored tree (the default cwd), whatever the cwd is: the loaded core
  // pieces resolve from it, and an installed piece may link into it.
  add(ENGINE_BUILD_PATHS.VENDOR_PACKAGES);
  add(p.cwd);
  for (const root of p.customPiecesPaths ?? []) add(root);
  add(p.codeTree);
  if (p.transpilerCache && p.transpilerCache !== "0") add(p.transpilerCache);
  return { readOnly: [...readOnly], readWrite: [...SYSTEM_READ_WRITE, p.privateDir] };
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A string literal in Seatbelt's profile language. */
function sbplString(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Every spelling of a path Seatbelt may see: as given, and resolved. */
function spellings(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    out.add(path);
    out.add(realOrSelf(path));
  }
  return [...out];
}

/**
 * The sandbox-exec profile for an allow-list. Later rules win in Seatbelt,
 * so: everything allowed (mach services, network, signals: the sandbox is
 * about files), then every file read and write denied, then stat allowed
 * everywhere, then the listed paths, then no exec from the writable ones.
 */
export function seatbeltProfile(allow: { readOnly: readonly string[]; readWrite: readonly string[] }): string {
  const ro = spellings(allow.readOnly);
  const rw = spellings(allow.readWrite);
  const subpaths = (paths: string[]) => paths.map((path) => `(subpath ${sbplString(path)})`).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-read* file-write*)",
    "(allow file-read-metadata)",
    `(allow file-read* (literal "/") ${subpaths([...ro, ...rw])})`,
    `(allow file-write* ${subpaths(rw)})`,
  ];
  const noExec = rw.filter((path) => !path.startsWith("/dev/"));
  if (noExec.length > 0) lines.push(`(deny process-exec* ${subpaths(noExec)})`);
  return lines.join("\n") + "\n";
}

/** argv for the launcher: the rules, then the command it execs. */
export function sandboxArgv(sandbox: ActiveSandbox, allow: { readOnly: readonly string[]; readWrite: readonly string[] }, command: readonly string[]): string[] {
  return sandbox.kind === "seatbelt" ? ["-p", seatbeltProfile(allow), ...command] : launcherArgs(allow, command);
}

/**
 * Whether sandbox-exec works here: Bun must start under a profile built like
 * an engine's and must NOT be able to list the home directory. Either failing
 * means no sandbox, and the setting decides what happens instead.
 */
function seatbeltSupport(): SandboxSupport {
  if (!existsSync(SANDBOX_EXEC)) return { kind: "none", reason: `${SANDBOX_EXEC} is missing` };
  const allow = {
    readOnly: [...SYSTEM_READ_ONLY_DARWIN, realOrSelf(process.execPath)],
    readWrite: [...SYSTEM_READ_WRITE],
  };
  const check = "try { require('fs').readdirSync(require('os').homedir()); process.exit(3) } catch { process.exit(0) }";
  const probe = spawnSync(SANDBOX_EXEC, ["-p", seatbeltProfile(allow), process.execPath, "--no-env-file", "-e", check], {
    encoding: "utf8", timeout: 15_000, env: sanitizedEnv(), cwd: "/",
  });
  if (probe.error) return { kind: "none", reason: `sandbox-exec failed to start: ${probe.error.message}` };
  if (probe.status === 3) return { kind: "none", reason: "sandbox-exec ran Bun but did not restrict its file access" };
  if (probe.status !== 0) {
    return { kind: "none", reason: `Bun did not start under sandbox-exec (exit ${probe.status}): ${probe.stderr.trim().slice(0, 300)}` };
  }
  return { kind: "seatbelt", launcher: SANDBOX_EXEC };
}

/** argv for the launcher: the rules, then the command it execs. */
export function launcherArgs(allow: { readOnly: readonly string[]; readWrite: readonly string[] }, command: readonly string[]): string[] {
  const args: string[] = [];
  for (const path of allow.readOnly) args.push("--ro", path);
  for (const path of allow.readWrite) args.push("--rw", path);
  args.push("--", ...command);
  return args;
}

/**
 * A flow version id that names exactly one directory under the code base, or
 * null. Version ids are generated ids; anything with a separator or a dot
 * segment is not one, and is never turned into a path.
 */
export function codeTreeFor(baseCodeDir: string, flowVersionId: string | undefined): string | null {
  if (!flowVersionId || !/^[A-Za-z0-9_-]{1,128}$/.test(flowVersionId)) return null;
  return resolve(baseCodeDir, flowVersionId);
}

/** The identity of a directory, to notice it being replaced under a warm engine. */
export function dirIdentity(path: string): string | null {
  try {
    const st = statSync(path);
    return st.isDirectory() ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}
