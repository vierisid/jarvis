/**
 * Health Monitor
 *
 * Monitors daemon health, service status, memory usage, and database connectivity.
 * Runs periodic health checks and logs warnings when issues are detected.
 */

import { existsSync, statSync } from "node:fs";
import { ServiceRegistry, type ServiceStatus } from "./services.ts";
import { getDb } from "../vault/schema.ts";
import { checkDatabaseFile, databaseLostMessage } from "../vault/db-guard.ts";

export type HealthStatus = {
  uptime: number;           // seconds
  services: Record<string, ServiceStatus>;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  database: { connected: boolean; size: number; problem?: string };  // DB file size in bytes; problem when the file was deleted, emptied or swapped
  startedAt: number;        // epoch ms
};

export class HealthMonitor {
  private startTime: number;
  private registry: ServiceRegistry;
  private checkInterval: Timer | null = null;
  private dbPath: string;

  constructor(registry: ServiceRegistry, dbPath: string) {
    this.startTime = Date.now();
    this.registry = registry;
    this.dbPath = dbPath;
  }

  /**
   * Start periodic health checks
   * @param intervalMs - Check interval in milliseconds (default: 30 seconds)
   */
  start(intervalMs: number = 30000): void {
    if (this.checkInterval) {
      console.log('[HealthMonitor] Already running');
      return;
    }

    console.log(`[HealthMonitor] Starting health checks (every ${intervalMs}ms)`);
    this.checkInterval = setInterval(() => {
      this.check();
    }, intervalMs);

    // Run initial check
    this.check();
  }

  /**
   * Stop periodic health checks
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('[HealthMonitor] Stopped');
    }
  }

  /**
   * Get current health status
   */
  getHealth(): HealthStatus {
    const now = Date.now();
    const uptime = Math.floor((now - this.startTime) / 1000);
    const services = this.registry.getStatus();
    const memory = this.getMemoryStats();
    const database = this.getDatabaseStats();

    return {
      uptime,
      services,
      memory,
      database,
      startedAt: this.startTime,
    };
  }

  /**
   * Perform health check and log warnings
   */
  private check(): void {
    const health = this.getHealth();

    // Check service health
    const unhealthyServices = Object.entries(health.services)
      .filter(([_, status]) => status === 'error' || status === 'stopping');

    if (unhealthyServices.length > 0) {
      console.warn('[HealthMonitor] ⚠ Unhealthy services detected:');
      for (const [name, status] of unhealthyServices) {
        const info = this.registry.getServiceInfo(name);
        const error = info?.error ? ` - ${info.error}` : '';
        console.warn(`  - ${name}: ${status}${error}`);
      }
    }

    // Check database connectivity
    if (!health.database.connected) {
      console.warn('[HealthMonitor] ⚠ Database not connected');
    }

    // Check memory usage (warn if > 500MB)
    const memoryMB = health.memory.rss / (1024 * 1024);
    if (memoryMB > 500) {
      console.warn(
        `[HealthMonitor] ⚠ High memory usage: ${memoryMB.toFixed(2)}MB RSS`
      );
    }

    // Log uptime milestone (every hour)
    if (health.uptime > 0 && health.uptime % 3600 === 0) {
      const hours = health.uptime / 3600;
      console.log(`[HealthMonitor] Uptime: ${hours} hour${hours > 1 ? 's' : ''}`);
    }
  }

  /**
   * Get memory statistics
   */
  private getMemoryStats(): { heapUsed: number; heapTotal: number; rss: number } {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
    };
  }

  /**
   * Get database statistics
   */
  private getDatabaseStats(): { connected: boolean; size: number; problem?: string } {
    let connected = false;
    let size = 0;

    try {
      const db = getDb();
      // Simple query to check if DB is responsive
      db.query("SELECT 1").get();
      connected = true;

      // Get DB file size if it's not in-memory
      if (this.dbPath !== ':memory:' && existsSync(this.dbPath)) {
        const stats = statSync(this.dbPath);
        size = stats.size;
      }
    } catch (error) {
      // DB not connected or not initialized
      connected = false;
    }

    // The handle still answers after the file is deleted, truncated or swapped,
    // so "connected" also needs the file on disk to be the one Jarvis opened.
    checkDatabaseFile();
    const problem = databaseLostMessage();
    if (problem) return { connected: false, size, problem };
    return { connected, size };
  }

  /**
   * Format health status as human-readable string
   */
  formatHealth(): string {
    const health = this.getHealth();
    const lines: string[] = [];

    lines.push('=== JARVIS Health Status ===');
    lines.push(`Uptime: ${this.formatUptime(health.uptime)}`);
    lines.push(`Started: ${new Date(health.startedAt).toISOString()}`);
    lines.push('');

    lines.push('Services:');
    for (const [name, status] of Object.entries(health.services)) {
      const icon = status === 'running' ? '✓' : status === 'error' ? '✗' : '○';
      lines.push(`  ${icon} ${name}: ${status}`);
    }
    lines.push('');

    lines.push('Memory:');
    lines.push(`  Heap: ${this.formatBytes(health.memory.heapUsed)} / ${this.formatBytes(health.memory.heapTotal)}`);
    lines.push(`  RSS: ${this.formatBytes(health.memory.rss)}`);
    lines.push('');

    lines.push('Database:');
    lines.push(`  Connected: ${health.database.connected ? 'Yes' : 'No'}`);
    lines.push(`  Size: ${this.formatBytes(health.database.size)}`);

    return lines.join('\n');
  }

  /**
   * Format uptime in human-readable format
   */
  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
  }

  /**
   * Format bytes in human-readable format
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const size = bytes / Math.pow(k, i);

    return `${size.toFixed(2)} ${sizes[i]}`;
  }
}
