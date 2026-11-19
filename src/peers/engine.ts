/**
 * The engine, kept up.
 *
 * One engine runs under the brain for as long as the brain does. When it
 * falls it is started again, a little later each time it falls at once, and
 * whoever listens is told that it is down and that it is up again. A call
 * made while it is down fails at once: nothing is queued for an engine that
 * may come back as another one.
 */
import { EngineClient, EngineClosed } from './engine-client.ts';
import type { EngineDialog, EngineDialogAnswer, EngineToolResult, EngineTransport } from './engine-client.ts';
import { startEngine } from './engine-process.ts';
import { readEngine } from './engine-read.ts';
import type { EngineReadFlags, EngineReadName } from './engine-read.ts';

/** The first wait before a fallen engine is started again, and the longest. */
export const ENGINE_RESTART_FIRST_MS = 1_000;
export const ENGINE_RESTART_MAX_MS = 60_000;
/** An engine that stayed up this long fell for a new reason: the wait starts small again. */
export const ENGINE_STEADY_MS = 60_000;

export type EngineState = 'starting' | 'up' | 'down' | 'stopped';

export interface PeerEngineOptions {
  /** The engine program. */
  path: string;
  brainDataDir: string;
  env?: Record<string, string | undefined>;
  /** Puts a dialog to the person. See ./engine-client.ts: without it every dialog is closed. */
  onDialog?: (dialog: EngineDialog) => Promise<EngineDialogAnswer>;
  onNotice?: (method: string, params: Record<string, unknown>) => void;
  onState?: (state: EngineState) => void;
  log?: (line: string) => void;
  version?: string;
  /** For tests: another way to get a running program, and other clocks. */
  startChild?: () => { transport: EngineTransport; ended: Promise<number | null>; stop(): void };
  restartFirstMs?: number;
  restartMaxMs?: number;
  steadyMs?: number;
  now?: () => number;
}

export class PeerEngine {
  private client: EngineClient | null = null;
  private child: { stop(): void } | null = null;
  private current: EngineState = 'stopped';
  private wait: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private upSince = 0;
  /** Counts the starts, so that the end of an old engine cannot be taken for the end of the new. */
  private generation = 0;
  private wanted = false;

  constructor(private readonly options: PeerEngineOptions) {
    this.wait = options.restartFirstMs ?? ENGINE_RESTART_FIRST_MS;
  }

  state(): EngineState { return this.current; }

  /** Starts the engine and keeps it up until `stop`. */
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    void this.begin();
  }

  stop(): void {
    this.wanted = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.generation++;
    const child = this.child;
    this.child = null;
    this.client?.close();
    this.client = null;
    child?.stop();
    this.set('stopped');
  }

  /** Calls one of the engine's tools. Fails at once while the engine is not up. */
  call(tool: string, args: Record<string, unknown> = {}, limitMs?: number): Promise<EngineToolResult> {
    if (this.current !== 'up' || !this.client) return Promise.reject(new EngineClosed('the engine is not up'));
    return this.client.call(tool, args, limitMs);
  }

  /** Reads what the engine has stored, as data. Works while the engine is down too: it is another run of the program. */
  read(name: EngineReadName, flags?: EngineReadFlags): Promise<Record<string, unknown>> {
    return readEngine(name, { path: this.options.path, brainDataDir: this.options.brainDataDir, env: this.options.env }, flags);
  }

  private set(state: EngineState): void {
    if (this.current === state) return;
    this.current = state;
    try { this.options.onState?.(state); } catch { /* a listener's own fault */ }
  }

  private async begin(): Promise<void> {
    if (!this.wanted) return;
    const generation = ++this.generation;
    this.set('starting');
    let child: { transport: EngineTransport; ended: Promise<number | null>; stop(): void };
    try {
      child = this.options.startChild ? this.options.startChild() : startEngine({ path: this.options.path, brainDataDir: this.options.brainDataDir, env: this.options.env });
    } catch {
      // The program is not there, or may not be run. Tried again, at the longest wait: it does not appear by itself often.
      this.options.log?.('[peers] the engine could not be started');
      this.wait = this.options.restartMaxMs ?? ENGINE_RESTART_MAX_MS;
      this.fell(generation);
      return;
    }
    this.child = child;
    const client = new EngineClient(child.transport, {
      onDialog: this.options.onDialog,
      onNotice: this.options.onNotice,
      version: this.options.version,
    });
    this.client = client;
    client.onClosed(() => this.fell(generation));
    void child.ended.then(() => this.fell(generation));
    try {
      const hello = await client.start();
      if (generation !== this.generation) return;
      this.upSince = (this.options.now ?? Date.now)();
      this.options.log?.(`[peers] engine up (${hello.name} ${hello.version}, protocol ${hello.protocol})`);
      this.set('up');
    } catch {
      if (generation !== this.generation) return;
      client.close();
      child.stop();
      this.fell(generation);
    }
  }

  /** The engine of that start is gone. Starts another, later. */
  private fell(generation: number): void {
    if (generation !== this.generation || !this.wanted) return;
    // This start is over. Closing what is left of it tells this function again, and that telling is not heard.
    this.generation++;
    const now = (this.options.now ?? Date.now)();
    const first = this.options.restartFirstMs ?? ENGINE_RESTART_FIRST_MS;
    if (this.current === 'up' && now - this.upSince >= (this.options.steadyMs ?? ENGINE_STEADY_MS)) this.wait = first;
    const client = this.client;
    const child = this.child;
    this.client = null;
    this.child = null;
    client?.close();
    child?.stop();
    this.set('down');
    const wait = this.wait;
    this.wait = Math.min(this.wait * 2, this.options.restartMaxMs ?? ENGINE_RESTART_MAX_MS);
    this.options.log?.(`[peers] engine down, starting it again in ${Math.round(wait / 1000)} s`);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.begin(); }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
