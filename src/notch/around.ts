/**
 * What is going on around the person: on a call, and online.
 *
 * Two things the notch does in pass 8 rest on facts only the person's own
 * machine can know, and the desktop app says them (`notch.around`,
 * sidecar/notch_around.go):
 *
 *   - **On a call, everything is held.** A program people make calls with has
 *     the microphone. The notch says so once, takes nothing to the person
 *     while it lasts, and offers what it held when the call is over.
 *   - **Connection lost is said, once.** And said again when it is back.
 *
 * A fact the desktop app cannot tell (an older one, or a system it does not
 * read this on) is simply not there: nothing is held for a call that cannot
 * be known, and nothing is said about a connection that cannot be known.
 */
import type { NotchInbox } from './inbox.ts';
import type { NotchPart } from './protocol.ts';
import type { NotchClock } from './stage.ts';
import { realNotchClock } from './stage.ts';
import type { NotchSurface } from './surface.ts';

export const NOTCH_AROUND_EVENT = 'notch.around';

/** A microphone in use for this long is a call. A shorter use is someone dictating a sentence. */
export const NOTCH_CALL_AFTER_MS = 60 * 1000;
/** A microphone given back for this long is the end of the call. A shorter gap is the program changing devices. */
export const NOTCH_CALL_ENDS_AFTER_MS = 15 * 1000;
/** No call lasts this long: what says so is a record that was never closed. */
export const NOTCH_CALL_MOST_MS = 3 * 60 * 60 * 1000;
/** How often "on a call" is tried again while the notch is taken by something the person is doing. */
export const NOTCH_CALL_SAY_AGAIN_MS = 5 * 1000;
/** How long the connection has to be gone before it is said: a blink is not said. */
export const NOTCH_OFFLINE_AFTER_MS = 8 * 1000;

export interface NotchAroundPort {
  onEvent(listener: (sidecarId: string, event: { event_type: string; payload: unknown }) => void): void;
  onSidecarDisconnected?(listener: (sidecarId: string) => void): void;
}

export interface NotchAroundDeps {
  /** Whether a meeting with other people is in the calendar for this moment: then a microphone in use is a call at once. */
  meetingNow?(): boolean;
  /** Everything is stopped: nothing is said. */
  asleep?(): boolean;
  /** The connection is back: what waited for it can go on. */
  backOnline?(): void;
  clock?: NotchClock;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchAround {
  /** Whether the person is on a call now, as far as is known. */
  onCall(): boolean;
  /** Whether the machine has a connection: false only when the desktop app said it has none. */
  online(): boolean;
  stop(): void;
}

const em = (text: string): NotchPart => ({ em: text });
const HOLD = 'call';

export function attachNotchAround(surface: NotchSurface, inbox: NotchInbox, port: NotchAroundPort, deps: NotchAroundDeps = {}): NotchAround {
  const clock = deps.clock ?? realNotchClock;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let stopped = false;

  // ---- a call ----
  /** Since when a calling program has had the microphone, or null. */
  let micSince: number | null = null;
  let inCall = false;
  let callSince = 0;
  /** How many things waited when the call began: what arrived during it is the rest. */
  let waitedBefore = 0;
  let starting: unknown = null;
  let ending: unknown = null;
  let longest: unknown = null;
  let parked = -1;
  let parking: unknown = null;
  /** Whether the inbox is held for the call: it is from the moment the call was said. */
  let holding = false;
  let saying: unknown = null;

  const held = (): number => Math.max(0, inbox.count() - waitedBefore);
  const park = (): void => {
    if (!inCall) return;
    const many = Math.min(held(), 3);
    if (many !== parked) { parked = many; surface.act({ park: many }); }
    parking = clock.setTimeout(park, 2000);
  };

  function begin(): void {
    if (inCall || stopped) return;
    inCall = true;
    callSince = now();
    waitedBefore = inbox.count();
    log('[notch] on a call: everything is held');
    // Said once, when the notch is free to say it. Then nothing more comes until the call is over.
    // Something the person is in the middle of on the notch is not taken from them for it: it waits.
    const hold = (): void => { if (inCall && !holding) { holding = true; inbox.hold(HOLD); parked = -1; park(); } };
    const say = (): void => {
      saying = null;
      if (!inCall || holding) return;
      if (deps.asleep?.()) { hold(); return; }
      const said = inbox.present('call', async (stage) => {
        try { await stage.say(['On a call. I hold everything until you are done.'], 3000, { mood: 'focus' }); } finally { hold(); }
      });
      if (!said) saying = clock.setTimeout(say, NOTCH_CALL_SAY_AGAIN_MS);
    };
    say();
    longest = clock.setTimeout(() => { longest = null; log('[notch] a call of three hours is taken to be over'); end(); }, NOTCH_CALL_MOST_MS);
  }

  function end(): void {
    if (!inCall) return;
    inCall = false;
    if (longest) { clock.clearTimeout(longest); longest = null; }
    if (parking) { clock.clearTimeout(parking); parking = null; }
    if (saying) { clock.clearTimeout(saying); saying = null; }
    // It was never said, so nothing was held: the call came and went while the person was busy on the notch.
    if (!holding) { log('[notch] the call is over before it was said'); return; }
    holding = false;
    const many = held();
    const minutes = Math.round((now() - callSince) / 60_000);
    log(`[notch] the call is over after ${minutes} min: ${many} held`);
    // What waited on the edge is pulled in, and it stretches awake. Not when
    // its eyes are closed or turned aside: waking would open them.
    surface.act(surface.resting() === 'idle' || surface.resting() === 'focus' ? { park: 0, gesture: 'wake' } : { park: 0 });
    const release = (): void => inbox.release(HOLD);
    if (many === 0 || deps.asleep?.()) { release(); return; }
    // What was held is offered before anything speaks for itself: the hold is let go when this line is done.
    let show = false;
    const offered = inbox.present('call-over', async (stage) => {
      try {
        const answer = await stage.offer(['Call ended. I held ', em(many === 1 ? '1 thing' : `${many} things`), '.'], 'show', { mood: 'idle' });
        show = answer.act === 'yes';
      } finally {
        release();
        // After this script has ended: the notch shows one thing at a time.
        if (show) clock.setTimeout(() => { if (!stopped) inbox.open(); }, 0);
      }
    }, { held: true });
    if (!offered) release();
  }

  function mic(inUse: boolean | null): void {
    if (starting) { clock.clearTimeout(starting); starting = null; }
    if (inUse) {
      if (ending) { clock.clearTimeout(ending); ending = null; }
      if (micSince === null) micSince = now();
      if (inCall) return;
      // With a meeting in the calendar for this moment, it is the call. Without one, a sentence dictated is not.
      const wait = deps.meetingNow?.() ? 0 : Math.max(0, NOTCH_CALL_AFTER_MS - (now() - micSince));
      if (wait === 0) begin();
      else starting = clock.setTimeout(() => { starting = null; if (micSince !== null) begin(); }, wait);
      return;
    }
    micSince = null;
    if (!inCall || ending) return;
    // Not known any more (the desktop app is gone) ends it at once: nothing is held on a guess.
    if (inUse === null) { end(); return; }
    ending = clock.setTimeout(() => { ending = null; if (micSince === null) end(); }, NOTCH_CALL_ENDS_AFTER_MS);
  }

  // ---- the connection ----
  let isOnline = true;
  let saidOffline = false;
  let goingOffline: unknown = null;

  function connection(online: boolean | null): void {
    if (online === false) {
      if (!isOnline || goingOffline) return;
      goingOffline = clock.setTimeout(() => {
        goingOffline = null;
        isOnline = false;
        log('[notch] the machine has no connection');
        if (!deps.asleep?.()) saidOffline = inbox.present('offline', (stage) => stage.say(['No connection. I carry on when it is back.'], 4200, { mood: 'worried' }));
      }, NOTCH_OFFLINE_AFTER_MS);
      return;
    }
    if (goingOffline) { clock.clearTimeout(goingOffline); goingOffline = null; }
    // Not known any more: nothing is called lost on that machine's last word, and nothing is called back.
    if (online === null) { isOnline = true; saidOffline = false; return; }
    if (isOnline) return;
    isOnline = true;
    log('[notch] the connection is back');
    // Said only if its going was said: a return nobody was told to wait for is no news.
    if (saidOffline && !deps.asleep?.()) inbox.present('online', (stage) => stage.say(['Back online.'], 2200, { mood: 'happy', mark: 'check' }));
    saidOffline = false;
    try { deps.backOnline?.(); } catch (error) { log(`[notch] going on after the connection came back failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The machine whose word is taken: the one that spoke last. */
  let from: string | null = null;
  port.onEvent((sidecarId, event) => {
    if (stopped || event.event_type !== NOTCH_AROUND_EVENT) return;
    const told = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : null;
    if (!told) return;
    from = sidecarId;
    if (typeof told.call === 'boolean') mic(told.call);
    if (typeof told.online === 'boolean') connection(told.online);
  });
  port.onSidecarDisconnected?.((sidecarId) => {
    if (stopped || sidecarId !== from) return;
    from = null;
    // Nothing is known of that machine any more: no call is held on its last word, and no connection is called lost.
    mic(null);
    connection(null);
  });

  return {
    onCall: () => inCall,
    online: () => isOnline,
    stop: () => {
      stopped = true;
      for (const timer of [starting, ending, longest, parking, saying, goingOffline]) if (timer) clock.clearTimeout(timer);
      if (inCall) { inCall = false; surface.act({ park: 0 }); if (holding) inbox.release(HOLD); holding = false; }
    },
  };
}
