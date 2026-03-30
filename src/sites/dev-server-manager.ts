/**
 * Site Builder — Dev Server Manager
 *
 * Manages spawned `make dev` processes for project previews.
 * Tracks PIDs for cleanup, manages port allocation, health checks.
 */

import type { Subprocess } from 'bun';
import type { SiteBuilderConfig } from './types.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';

type RunningServer = {
  proc: Subprocess;
  port: number;
  projectId: string;
  projectPath: string;
  logs: string[];
  startedAt: number;
};

const MAX_LOG_LINES = 500;
const READY_POLL_INTERVAL = 500;
const READY_TIMEOUT = 30_000;

export class DevServerManager {
  private servers = new Map<string, RunningServer>();
  private allocatedPorts = new Set<number>();
  private portStart: number;
  private portEnd: number;
  private maxConcurrent: number;
  private pidFilePath: string;

  constructor(config: SiteBuilderConfig) {
    this.portStart = config.port_range_start;
    this.portEnd = config.port_range_end;
    this.maxConcurrent = config.max_concurrent_servers;
    this.pidFilePath = join(config.projects_dir.replace(/^~/, homedir()), '.running-pids.json');
  }

  /**
   * Start a dev server for a project.
   */
  async start(projectId: string, projectPath: string): Promise<{ port: number; pid: number }> {
    // Already running?
    if (this.servers.has(projectId)) {
      const existing = this.servers.get(projectId)!;
      return { port: existing.port, pid: existing.proc.pid };
    }

    // Check concurrency limit
    if (this.servers.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent servers reached (${this.maxConcurrent}). Stop another project first.`);
    }

    const port = await this.allocatePort();

    const proc = Bun.spawn(['make', 'dev'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PORT: String(port),
        // Enforce loopback bind — prevent dev servers from listening on 0.0.0.0
        HOST: '127.0.0.1',
      },
    });

    const server: RunningServer = {
      proc,
      port,
      projectId,
      projectPath,
      logs: [],
      startedAt: Date.now(),
    };

    this.servers.set(projectId, server);

    // Pipe stdout/stderr to log buffer
    this.pipeToLogs(server, proc.stdout, 'stdout');
    this.pipeToLogs(server, proc.stderr, 'stderr');

    // Handle process exit
    proc.exited.then(code => {
      if (this.servers.get(projectId) === server) {
        this.servers.delete(projectId);
        this.releasePort(port);
        console.log(`[SiteBuilder] Dev server for "${projectId}" exited with code ${code}`);
      }
    });

    // Save PIDs for crash recovery
    this.savePids();

    console.log(`[SiteBuilder] Starting dev server for "${projectId}" on port ${port} (pid ${proc.pid})`);

    return { port, pid: proc.pid };
  }

  /**
   * Stop a running dev server.
   */
  async stop(projectId: string): Promise<void> {
    const server = this.servers.get(projectId);
    if (!server) return;

    try {
      server.proc.kill();
      // Give it a moment to exit gracefully
      await Promise.race([
        server.proc.exited,
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    } catch { /* process may already be dead */ }

    this.servers.delete(projectId);
    this.releasePort(server.port);
    this.savePids();

    console.log(`[SiteBuilder] Stopped dev server for "${projectId}"`);
  }

  /**
   * Stop all running dev servers.
   */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map(id => this.stop(id)));
  }

  /**
   * Check if a dev server is running.
   */
  isRunning(projectId: string): boolean {
    return this.servers.has(projectId);
  }

  /**
   * Get the port for a running project.
   */
  getPort(projectId: string): number | null {
    return this.servers.get(projectId)?.port ?? null;
  }

  /**
   * Get recent logs for a project's dev server.
   */
  getLogs(projectId: string, limit: number = 100): string[] {
    const server = this.servers.get(projectId);
    if (!server) return [];
    return server.logs.slice(-limit);
  }

  /**
   * Wait for the dev server to respond on its port.
   */
  async waitForReady(port: number, timeoutMs: number = READY_TIMEOUT): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.status < 500) return true;
      } catch { /* server not ready yet */ }
      await Bun.sleep(READY_POLL_INTERVAL);
    }
    return false;
  }

  /**
   * Get info about all running servers.
   */
  getRunningServers(): Array<{ projectId: string; port: number; pid: number; startedAt: number }> {
    return Array.from(this.servers.values()).map(s => ({
      projectId: s.projectId,
      port: s.port,
      pid: s.proc.pid,
      startedAt: s.startedAt,
    }));
  }

  // ── Port Management ──

  private async allocatePort(): Promise<number> {
    for (let port = this.portStart; port <= this.portEnd; port++) {
      if (!this.allocatedPorts.has(port)) {
        // Verify the port is actually free on the system
        const available = await this.isPortAvailable(port);
        if (available) {
          this.allocatedPorts.add(port);
          return port;
        }
      }
    }
    throw new Error(`No available ports in range ${this.portStart}-${this.portEnd}`);
  }

  /** Probe whether a port is free by attempting a TCP connect */
  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const { createServer } = require('node:net');
      const server = createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => { server.close(() => resolve(true)); });
      server.listen(port, '127.0.0.1');
    });
  }

  private releasePort(port: number): void {
    this.allocatedPorts.delete(port);
  }

  // ── Log Piping ──

  private async pipeToLogs(server: RunningServer, stream: ReadableStream<Uint8Array> | null, label: string): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter(l => l.trim());
        for (const line of lines) {
          server.logs.push(`[${label}] ${line}`);
          if (server.logs.length > MAX_LOG_LINES) {
            server.logs.shift();
          }
        }
      }
    } catch { /* stream closed */ }
  }

  // ── PID Persistence ──

  private savePids(): void {
    const pids: Record<string, { pid: number; port: number; projectPath: string }> = {};
    for (const [id, server] of this.servers) {
      pids[id] = { pid: server.proc.pid, port: server.port, projectPath: server.projectPath };
    }
    try {
      Bun.write(this.pidFilePath, JSON.stringify(pids, null, 2));
    } catch { /* best effort */ }
  }

  /**
   * Kill any orphaned processes from a previous crash.
   */
  async cleanupOrphans(): Promise<void> {
    try {
      const file = Bun.file(this.pidFilePath);
      if (!await file.exists()) return;

      const { readFileSync, unlinkSync } = await import('node:fs');

      const pids = JSON.parse(await file.text()) as Record<string, { pid: number; port: number }>;
      for (const [id, { pid }] of Object.entries(pids)) {
        try {
          // Verify PID belongs to a Jarvis-spawned process before killing
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
          const isMakeDev = cmdline.includes('make') && cmdline.includes('dev');
          const isBunHot = cmdline.includes('bun') && cmdline.includes('--hot');
          const isVite = cmdline.includes('vite');
          const isNext = cmdline.includes('next');
          if (isMakeDev || isBunHot || isVite || isNext) {
            process.kill(pid, 'SIGTERM');
            console.log(`[SiteBuilder] Killed orphaned process ${pid} for project "${id}"`);
          } else {
            console.log(`[SiteBuilder] Skipped PID ${pid} — not a recognized dev server process`);
          }
        } catch { /* process already gone or /proc not available */ }
      }

      // Clean up the PID file
      try { unlinkSync(this.pidFilePath); } catch { /* ignore */ }
    } catch { /* no PID file or parse error */ }
  }
}
