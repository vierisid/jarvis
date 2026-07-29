/**
 * Observer Service — account-level integrations (Gmail, Calendar).
 *
 * Wraps ObserverManager and routes its events to the vault + classifier
 * (EventReactor immediate / EventCoalescer batched) and, via the daemon's
 * forward callback, the workflow event bus.
 *
 * Host-sensing observers (file watcher, clipboard, process monitor, desktop
 * notifications) used to live here too. In the ambient/pebble model the SIDECAR
 * is the agent that runs on the user's machine, so all machine-level
 * observation now runs there (see StartObservers in sidecar/observers.go) and
 * streams to the brain, which ingests it in src/daemon/index.ts. This service
 * keeps only the account-level integrations, which are not tied to one machine.
 */

import type { Service, ServiceStatus } from './services.ts';
import type { ObserverEvent } from '../observers/index.ts';
import type { ObservationType } from '../vault/observations.ts';
import type { EventReactor } from './event-reactor.ts';
import type { EventCoalescer } from './event-coalescer.ts';
import type { GoogleAuth } from '../integrations/google-auth.ts';

import { homedir } from 'node:os';
import { ObserverManager } from '../observers/index.ts';
import { EmailSync } from '../observers/email.ts';
import { CalendarSync } from '../observers/calendar.ts';
import { createObservation } from '../vault/observations.ts';
import { classifyEvent } from './event-classifier.ts';

/**
 * Map observer event types to vault observation types.
 */
export function mapEventType(eventType: string): ObservationType {
  switch (eventType) {
    case 'file_change':
      return 'file_change';
    case 'clipboard':
      return 'clipboard';
    case 'process_started':
    case 'process_stopped':
      return 'process';
    case 'notification':
      return 'notification';
    case 'calendar':
      return 'calendar';
    case 'email':
      return 'email';
    case 'browser':
      return 'browser';
    case 'screen_capture':
    case 'context_changed':
    case 'error_detected':
    case 'stuck_detected':
    case 'session_started':
    case 'session_ended':
    case 'suggestion_ready':
      return 'screen_capture';
    default:
      return 'app_activity';
  }
}

export class ObserverService implements Service {
  name = 'observers';
  private _status: ServiceStatus = 'stopped';
  private manager: ObserverManager;
  private reactor: EventReactor | null;
  private coalescer: EventCoalescer | null;
  private googleAuth: GoogleAuth | null;
  private dataDir: string;
  /**
   * Optional fan-out callback fired on every observer event AFTER the vault
   * write and reactor/coalescer routing. Used by the workflow runtime to
   * republish events onto its bus so `on_event` triggers can fire. Errors in
   * the callback are caught and logged so the main pipeline never breaks.
   */
  private forwardCallback: ((event: ObserverEvent) => void) | null = null;

  constructor(
    reactor?: EventReactor,
    coalescer?: EventCoalescer,
    googleAuth?: GoogleAuth,
    dataDir?: string,
  ) {
    this.manager = new ObserverManager();
    this.reactor = reactor ?? null;
    this.coalescer = coalescer ?? null;
    this.googleAuth = googleAuth ?? null;
    this.dataDir = dataDir ?? `${homedir()}/.jarvis`;
  }

  /**
   * Register a side-channel handler called after the standard reactor /
   * coalescer routing. Replaces any previously-set forward callback.
   */
  setForwardCallback(cb: (event: ObserverEvent) => void): void {
    this.forwardCallback = cb;
  }

  /**
   * Swap the Google auth used by the email/calendar observers (settings hot
   * reload). Takes effect on the next start(): EmailSync/CalendarSync are
   * constructed there and capture the auth reference, so callers should
   * stop() + start() the service after swapping.
   */
  setGoogleAuth(auth: GoogleAuth | null): void {
    this.googleAuth = auth;
  }

  async start(): Promise<void> {
    this._status = 'starting';

    try {
      // Host-sensing observers (file watcher, clipboard, process monitor,
      // desktop notifications) now run in the sidecar (sidecar/observers.go)
      // and stream to the brain, which ingests them in src/daemon/index.ts.
      // This service registers only the account-level integrations below.
      //
      // NB: this supersedes the JARVIS_FILE_WATCH_PATHS boot-hang workaround
      // (#246) — there is no brain-side file watcher to hang boot anymore.

      // Register Gmail observer (if Google auth available)
      this.manager.register(new EmailSync(this.googleAuth ?? undefined));

      // Register Calendar observer (if Google auth available)
      this.manager.register(new CalendarSync(this.googleAuth ?? undefined));

      // Set event handler: store in vault + classify + route
      this.manager.setEventHandler((event: ObserverEvent) => {
        // 1. Always store in vault
        try {
          const obsType = mapEventType(event.type);
          createObservation(obsType, event.data);
        } catch (err) {
          console.error('[ObserverService] Error storing observation:', err);
        }

        // 2. Classify and route
        try {
          const classified = classifyEvent(event);

          if (classified.priority === 'critical' || classified.priority === 'high') {
            // Route to reactor for immediate handling
            if (this.reactor) {
              this.reactor.react(classified).catch(err =>
                console.error('[ObserverService] Reactor error:', err)
              );
            }
          } else {
            // Route to coalescer for batched delivery at heartbeat
            if (this.coalescer) {
              this.coalescer.addEvent(classified);
            }
          }
        } catch (err) {
          console.error('[ObserverService] Error classifying event:', err);
        }

        // 3. Forward to any side-channel consumers (workflow event bus, etc.).
        //    Catch errors so a broken consumer doesn't take down the observer pipeline.
        if (this.forwardCallback) {
          try {
            this.forwardCallback(event);
          } catch (err) {
            console.error('[ObserverService] forwardCallback error:', err);
          }
        }
      });

      // Start all observers (individual failures don't crash the service)
      await this.manager.startAll();

      this._status = 'running';
      console.log('[ObserverService] Started');
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async stop(): Promise<void> {
    this._status = 'stopping';
    await this.manager.stopAll();
    this._status = 'stopped';
    console.log('[ObserverService] Stopped');
  }

  status(): ServiceStatus {
    return this._status;
  }
}
