import type { CommandResult } from './executor.ts';
import { readFileSync, existsSync } from 'node:fs';
import { sanitizedEnv } from '../../util/subprocess-env.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Longest `-Command` argument runPowerShell hands powershell.exe. A Windows
 * command line tops out at 32,767 UTF-16 units, and WSL interop adds the
 * executable path and the other flags; past this, fail with a clear error
 * rather than a truncated or refused launch.
 */
export const POWERSHELL_COMMAND_MAX = 30_000;

/**
 * Windows interop from inside WSL.
 *
 * Every child is spawned from an argv array, never a shell string (#519): the
 * previous version built `$SHELL -c` command lines by interpolation, so a path
 * or script containing `$()` or a backtick ran in the Linux shell. With argv
 * there is no Linux shell to escape for. The Windows side has its own
 * command-line parsing, which argv alone does not neutralise, so what crosses
 * it is kept to text that no Windows parser treats specially: fixed flags,
 * plain paths for wslpath (a Linux binary, so no Windows parsing at all), and
 * base64 for PowerShell.
 *
 * There is deliberately no "run this cmd.exe command line" method. One existed
 * (runWindowsCommand) with no caller anywhere; a cmd.exe command line is code
 * by definition, and making data inside it safe depends both on cmd.exe's own
 * metacharacters (`& | < > ^ % ( ) "`) and on how WSL interop re-quotes argv
 * into a Windows command line. Run Windows programs with an argv array
 * instead, or through runPowerShell with the data kept out of the script.
 */
export class WSLBridge {
  private windowsHome: string | null = null;

  constructor() {
    if (WSLBridge.isWSL()) {
      this.detectWindowsHome();
    }
  }

  static isWSL(): boolean {
    try {
      if (process.platform !== 'linux') {
        return false;
      }

      if (existsSync('/proc/version')) {
        const version = readFileSync('/proc/version', 'utf-8').toLowerCase();
        return version.includes('microsoft') || version.includes('wsl');
      }

      if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Run `script` as PowerShell source. The script is CODE: never interpolate
   * a path, or any model- or user-supplied text, into it.
   *
   * It reaches powershell.exe as base64 of its UTF-8 inside a fixed wrapper,
   * the same way #515 carries toast text, so no quoting layer between here and
   * PowerShell's parser can change it. Not `-EncodedCommand` (UTF-16 base64,
   * twice the length, and it reports progress as CLIXML on stderr), not
   * `$args` (powershell.exe joins every argument after -Command into the
   * script), not stdin (read in the OEM code page).
   *
   * Known limitation, shared with the #515 toast: under Constrained Language
   * Mode (a WDAC or AppLocker policy) the wrapper cannot run, because
   * [Convert] and [Text.Encoding] are not core types there. The call fails
   * with a language-mode error rather than running anything else.
   */
  async runPowerShell(script: string): Promise<CommandResult> {
    if (!WSLBridge.isWSL()) {
      throw new Error('Not running in WSL environment');
    }

    try {
      return await runArgv(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', buildPowerShellCommand(script)]);
    } catch (error) {
      throw new Error(`Failed to run PowerShell script: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getWindowsHome(): string | null {
    return this.windowsHome;
  }

  private detectWindowsHome(): void {
    // Separate argv elements with no spaces or quotes, so WSL interop passes
    // them through unquoted and cmd.exe expands %USERPROFILE% itself. /d skips
    // AutoRun commands, which could otherwise print ahead of the echo.
    runArgv(['cmd.exe', '/d', '/c', 'echo', '%USERPROFILE%']).then(res => {
      const path = res.stdout.trim();

      if (path && !path.includes('%')) {
        this.windowsHome = this.convertWindowsPath(path);
      }
    }).catch(() => {
      this.windowsHome = null;
    });
  }

  private convertWindowsPath(windowsPath: string): string {
    const normalized = windowsPath.replace(/\\/g, '/');

    const driveMatch = normalized.match(/^([A-Z]):/i);
    if (driveMatch) {
      const drive = driveMatch[1]?.toLowerCase();
      const rest = normalized.slice(2);
      return `/mnt/${drive}${rest}`;
    }

    return normalized;
  }

  async convertToWindowsPath(wslPath: string): Promise<string> {
    if (!WSLBridge.isWSL()) {
      throw new Error('Not running in WSL environment');
    }

    try {
      return await runWslpath('-w', wslPath);
    } catch (error) {
      throw new Error(`Failed to convert WSL path: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async convertToWSLPath(windowsPath: string): Promise<string> {
    if (!WSLBridge.isWSL()) {
      throw new Error('Not running in WSL environment');
    }

    try {
      return await runWslpath('-u', windowsPath);
    } catch (error) {
      throw new Error(`Failed to convert Windows path: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Appended to every script. A bare `-Command` script exits 1 when its last
 * statement fails, but here the last statement powershell.exe sees is the
 * dot-source, whose own `$?` is true, so without this a failing script would
 * exit 0. On its own line, so a trailing comment cannot swallow it, and after
 * a `;`, so a trailing `|` cannot pipe into it.
 *
 * Not identical in every case: a script that leaves with `return` or `break`
 * skips this line and exits 0 even if the statement before failed, and one
 * that ends in a line-continuation backtick runs its last command where a bare
 * -Command would fail to parse.
 */
const EXIT_ON_FAILURE = '\n;if (-not $?) { exit 1 }';

/**
 * The `-Command` text for runPowerShell: a fixed wrapper that decodes the
 * script and dot-sources it, so it runs in the scope a bare `-Command` would
 * have given it and, with the caveats at EXIT_ON_FAILURE, its exit code. The wrapper has
 * no `"` and its only quotes enclose base64, whose alphabet no Windows or
 * PowerShell parser treats specially.
 */
export function buildPowerShellCommand(script: string): string {
  const encoded = Buffer.from(script + EXIT_ON_FAILURE, 'utf8').toString('base64');
  const command = `. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))`;

  if (command.length > POWERSHELL_COMMAND_MAX) {
    throw new Error(`script too long for a Windows command line (${command.length} > ${POWERSHELL_COMMAND_MAX} characters once encoded)`);
  }

  return command;
}

/**
 * wslpath is the Linux side of WSL, so argv reaches it exactly. It has no
 * `--`, so a path starting with `-` would be read as an option: refuse it
 * rather than guess (prefix a relative path with `./`).
 */
async function runWslpath(flag: '-w' | '-u', path: string): Promise<string> {
  if (path.startsWith('-')) {
    throw new Error(`refusing a path that starts with "-", which wslpath would read as an option: ${JSON.stringify(path)}`);
  }

  const result = await runArgv(['wslpath', flag, path]);

  if (result.exitCode !== 0) {
    throw new Error(`wslpath exited with code ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`);
  }

  // Only the terminator wslpath adds: leading or trailing spaces can be part
  // of the path.
  return result.stdout.replace(/\r?\n$/, '');
}

/**
 * Spawn `argv` with no shell. The env is the sanitized allowlist plus three
 * WSL names: WSL_INTEROP, the socket a Windows program is launched through on
 * WSL2 (the one interop needs); WSL_DISTRO_NAME, this distro's name; and
 * WSLENV, the list of variables shared with the Windows side (only names that
 * survive the allowlist can be). Keeping them is for interop to work, not a security
 * boundary: whether /init falls back to a default socket without WSL_INTEROP
 * was not verified.
 *
 * On timeout this stops waiting and kills the Linux-side process: for a
 * Windows program that is the interop relay, and the Windows process itself
 * may survive it. The child gets SIGKILL, its pipe readers are cancelled, and
 * the call rejects at once rather than waiting for pipes a grandchild can hold
 * open.
 *
 * @internal Exported for wsl-bridge.test.ts only.
 */
export async function runArgv(argv: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  const startTime = Date.now();

  const proc = Bun.spawn(argv, {
    env: sanitizedEnv({
      WSL_INTEROP: process.env.WSL_INTEROP,
      WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME,
      WSLENV: process.env.WSLENV,
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill('SIGKILL');
      // Stop buffering, and let go of the pipes, even if a grandchild still
      // holds them open.
      stdoutReader.cancel().catch(() => {});
      stderrReader.cancel().catch(() => {});
      reject(new Error(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([readText(stdoutReader), readText(stderrReader), proc.exited]),
      deadline,
    ]);

    return { stdout, stderr, exitCode, duration: Date.now() - startTime };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks).toString('utf-8');
}
