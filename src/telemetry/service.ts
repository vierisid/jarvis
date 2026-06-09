import type { Service, ServiceStatus } from '../daemon/services.ts';
import type { JarvisConfig } from '../config/types.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { resolveTelemetryEnabled } from './config.ts';
import { buildPayload, sendPing, type SendOutcome, type TelemetryPayload } from './client.ts';
import { HEARTBEAT_INTERVAL_MS } from './constants.ts';

/** settings-table key marking the first time telemetry ran on this install. */
const FIRST_SEEN_KEY = 'telemetry.first_seen_at';

/** A send function; injectable so tests can avoid the network. */
export type Sender = (payload: TelemetryPayload) => Promise<SendOutcome>;

export type TelemetryServiceOptions = {
  config: JarvisConfig;
  packageRoot: string;
  /** Override the sender (tests). Defaults to the real network sendPing. */
  sender?: Sender;
  /** Override debug logging (tests). Defaults to the JARVIS_TELEMETRY_DEBUG env. */
  debug?: boolean;
};

/** Treat unset/empty/0/false/no/off as "off". */
function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const s = value.trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off');
}

export class TelemetryService implements Service {
  readonly name = 'telemetry';
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: ServiceStatus = 'stopped';
  private payload: TelemetryPayload | null = null;
  private readonly send: Sender;
  private readonly debug: boolean;

  constructor(private readonly opts: TelemetryServiceOptions) {
    this.send = opts.sender ?? ((p) => sendPing(p));
    this.debug = opts.debug ?? envFlag(process.env.JARVIS_TELEMETRY_DEBUG);
  }

  status(): ServiceStatus {
    return this.state;
  }

  async start(): Promise<void> {
    // Telemetry must never break daemon startup. The registry re-throws
    // whatever a service.start() throws and aborts startAll(), and this
    // service is registered first -- so any uncaught error here would take
    // the whole daemon down. Swallow everything and always report running.
    try {
      const decision = resolveTelemetryEnabled(this.opts.config);
      if (!decision.enabled) {
        console.log(`[Telemetry] Disabled - ${decision.reason}.`);
        return;
      }

      this.announce();
      this.payload = buildPayload(this.opts.packageRoot);
      if (this.debug) {
        console.log(`[Telemetry] debug: payload=${JSON.stringify(this.payload)}`);
      }

      // Startup ping + 4-hourly heartbeat. Fire-and-forget; the .catch is
      // belt-and-suspenders against an unhandled rejection (fire() already
      // swallows its own errors).
      this.fire().catch(() => {});
      this.timer = setInterval(() => {
        this.fire().catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      // The heartbeat must not, by itself, keep the process alive.
      (this.timer as unknown as { unref?: () => void }).unref?.();
    } catch (err) {
      console.warn(
        `[Telemetry] Disabled - startup error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.state = 'running';
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state = 'stopped';
  }

  private async fire(): Promise<void> {
    if (!this.payload) return;
    let outcome: SendOutcome;
    try {
      outcome = await this.send(this.payload);
    } catch (err) {
      // The sender already swallows errors; this guards a misbehaving
      // injected sender so fire() can never reject.
      outcome = { ok: false, reason: 'network', error: err instanceof Error ? err.message : String(err) };
    }
    if (this.debug) {
      if (outcome.ok) {
        console.log(`[Telemetry] debug: ping ok (HTTP ${outcome.status}).`);
      } else {
        const detail =
          outcome.reason === 'http'
            ? `HTTP ${outcome.status}`
            : outcome.reason === 'network'
              ? outcome.error
              : outcome.reason;
        console.warn(`[Telemetry] debug: ping failed (${outcome.reason}: ${detail}).`);
      }
    }
  }

  /**
   * Show a prominent one-time notice on the first run (per install), and a
   * concise reminder on every subsequent start. The first-run flag is stored
   * in the settings table; if that read/write fails we fall back to the short
   * notice rather than risk crashing startup.
   */
  private announce(): void {
    let firstRun = false;
    try {
      if (!getSetting(FIRST_SEEN_KEY)) {
        firstRun = true;
        setSetting(FIRST_SEEN_KEY, String(Date.now()));
      }
    } catch {
      /* settings store not ready - degrade to the short notice below. */
    }

    if (firstRun) {
      console.log(
        [
          '',
          '+--- Anonymous usage metrics --------------------------------------+',
          '| JARVIS sends a small anonymous ping at startup and every 4 hours  |',
          '| so we can count unique installs and retention. No personal data,  |',
          '| no config, no content - just a hashed machine id, app version,    |',
          '| install method, and OS. Details: docs/TELEMETRY.md                |',
          '|                                                                   |',
          '| Opt out anytime: set `telemetry.enabled: false` in config.yaml,   |',
          '| or run with JARVIS_TELEMETRY=0 (DO_NOT_TRACK=1 is honored too).    |',
          '+-------------------------------------------------------------------+',
          '',
        ].join('\n'),
      );
    } else {
      console.log(
        '[Telemetry] Anonymous metrics on (opt out: telemetry.enabled=false or JARVIS_TELEMETRY=0).',
      );
    }
  }
}
