/**
 * ProcessMonitor - Monitors running processes
 *
 * Polls the system process list at regular intervals and detects when processes
 * start or terminate. Emits events for process lifecycle changes.
 */

import type { Observer, ObserverEvent, ObserverEventHandler } from './index';

export type ProcessInfo = {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
};

export class ProcessMonitor implements Observer {
  name = 'processes';
  private interval: Timer | null = null;
  private knownProcesses: Map<number, string> = new Map();
  private handler: ObserverEventHandler | null = null;
  private running = false;
  private pollMs: number;

  constructor(pollMs: number = 5000) {
    this.pollMs = pollMs;
  }

  async start(): Promise<void> {
    if (this.running) {
      console.log('[processes] Already running');
      return;
    }

    console.log(`[processes] Starting process monitoring (polling every ${this.pollMs}ms)...`);

    // Initialize with current process list
    try {
      const processes = await this.getProcessList();
      for (const proc of processes) {
        this.knownProcesses.set(proc.pid, proc.name);
      }
      console.log(`[processes] Initialized with ${processes.length} processes`);
    } catch (error) {
      console.error('[processes] Failed to get initial process list:', error);
    }

    // Start polling
    this.interval = setInterval(async () => {
      try {
        const processes = await this.getProcessList();
        const currentPids = new Set<number>();

        // Check for new processes
        for (const proc of processes) {
          currentPids.add(proc.pid);

          if (!this.knownProcesses.has(proc.pid)) {
            // New process detected
            this.knownProcesses.set(proc.pid, proc.name);

            if (this.handler) {
              const event: ObserverEvent = {
                type: 'process_started',
                data: {
                  pid: proc.pid,
                  name: proc.name,
                  cpu: proc.cpu,
                  memory: proc.memory,
                },
                timestamp: Date.now(),
              };

              this.handler(event);
            }
          }
        }

        // Check for terminated processes
        for (const [pid, name] of this.knownProcesses.entries()) {
          if (!currentPids.has(pid)) {
            // Process terminated
            this.knownProcesses.delete(pid);

            if (this.handler) {
              const event: ObserverEvent = {
                type: 'process_stopped',
                data: {
                  pid,
                  name,
                },
                timestamp: Date.now(),
              };

              this.handler(event);
            }
          }
        }
      } catch (error) {
        console.error('[processes] Failed to monitor processes:', error);
      }
    }, this.pollMs);

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    console.log('[processes] Stopping process monitoring...');

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.knownProcesses.clear();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  onEvent(handler: ObserverEventHandler): void {
    this.handler = handler;
  }

  /**
   * Get list of running processes
   */
  async getProcessList(): Promise<ProcessInfo[]> {
    const platform = process.platform;

    try {
      if (platform === 'linux' || platform === 'darwin') {
        // Use ps command for Unix-like systems
        const result = await Bun.$`ps aux --no-headers`.quiet();
        const output = result.stdout.toString();

        return this.parsePS(output);
      } else if (platform === 'win32') {
        // Use PowerShell for Windows
        const result = await Bun.$`powershell.exe -Command "Get-Process | Select-Object Id,Name,CPU,WorkingSet | ConvertTo-Csv -NoTypeInformation"`.quiet();
        const output = result.stdout.toString();

        return this.parseWindowsPS(output);
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error) {
      console.error('[processes] Failed to get process list:', error);
      return [];
    }
  }

  /**
   * Parse output from Unix ps command
   */
  private parsePS(output: string): ProcessInfo[] {
    const processes: ProcessInfo[] = [];
    const lines = output.split('\n').filter(line => line.trim());

    for (const line of lines) {
      // ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
      const parts = line.trim().split(/\s+/);

      if (parts.length < 11) {
        continue;
      }

      const pid = parseInt(parts[1]!, 10);
      const cpu = parseFloat(parts[2]!);
      const memory = parseFloat(parts[3]!);
      const name = parts.slice(10).join(' '); // COMMAND can have spaces

      if (!isNaN(pid)) {
        processes.push({
          pid,
          name,
          cpu,
          memory,
        });
      }
    }

    return processes;
  }

  /**
   * Parse output from Windows PowerShell Get-Process
   */
  private parseWindowsPS(output: string): ProcessInfo[] {
    const processes: ProcessInfo[] = [];
    const lines = output.split('\n').filter(line => line.trim());

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      const parts = line.split(',').map(p => p.replace(/"/g, '').trim());

      if (parts.length < 4) {
        continue;
      }

      const pid = parseInt(parts[0]!, 10);
      const name: string = parts[1]!;
      const cpu = parseFloat(parts[2]!) || 0;
      const memory = parseFloat(parts[3]!) || 0;

      if (!isNaN(pid)) {
        processes.push({
          pid,
          name,
          cpu,
          memory,
        });
      }
    }

    return processes;
  }
}
