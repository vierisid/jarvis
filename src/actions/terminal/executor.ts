import { spawn, type Subprocess } from 'bun';
import { modelExecEnv } from '../../util/model-exec-env.ts';

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
};

export type ExecuteOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
};

export class TerminalExecutor {
  private shell: string;
  private defaultTimeout: number;

  constructor(opts?: { shell?: string; timeout?: number }) {
    this.shell = opts?.shell ?? TerminalExecutor.detectShell();
    this.defaultTimeout = opts?.timeout ?? 30000;
  }

  async execute(command: string, opts?: ExecuteOptions): Promise<CommandResult> {
    const startTime = Date.now();
    const timeout = opts?.timeout ?? this.defaultTimeout;

    try {
      const proc = spawn({
        cmd: [this.shell, '-c', command],
        cwd: opts?.cwd,
        // run_command's shell runs a model-written command line: the user's
        // environment minus the daemon's own secrets (#514). Env hygiene,
        // not isolation -- see util/model-exec-env.ts.
        env: modelExecEnv(opts?.env),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const timeoutId = setTimeout(() => {
        proc.kill();
      }, timeout);

      const [stdout, stderr, exitCode] = await Promise.all([
        this.readStream(proc.stdout),
        this.readStream(proc.stderr),
        proc.exited,
      ]);

      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      return {
        stdout: stdout.toString('utf-8'),
        stderr: stderr.toString('utf-8'),
        exitCode: exitCode ?? 0,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      if (duration >= timeout) {
        throw new Error(`Command timed out after ${timeout}ms: ${command}`);
      }

      throw new Error(`Command execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async *stream(command: string, opts?: { cwd?: string; env?: Record<string, string> }): AsyncIterable<string> {
    const proc = spawn({
      cmd: [this.shell, '-c', command],
      cwd: opts?.cwd,
      env: modelExecEnv(opts?.env),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const decoder = new TextDecoder();

    if (!proc.stdout) {
      throw new Error('Failed to get stdout stream');
    }

    const reader = proc.stdout.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (value) {
          yield decoder.decode(value, { stream: true });
        }
      }
    } finally {
      reader.releaseLock();
      proc.kill();
    }
  }

  static detectShell(): string {
    const platform = process.platform;

    if (platform === 'win32') {
      return process.env.COMSPEC ?? 'powershell.exe';
    }

    if (process.env.SHELL) {
      return process.env.SHELL;
    }

    return '/bin/bash';
  }

  getShell(): string {
    return this.shell;
  }

  private async readStream(stream: ReadableStream<Uint8Array> | null): Promise<Buffer> {
    if (!stream) {
      return Buffer.from('');
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (value) {
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);

    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return Buffer.from(result);
  }
}
