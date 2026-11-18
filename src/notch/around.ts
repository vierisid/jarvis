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
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchClock, NotchStage } from './stage.ts';
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
/** How long "Back online" waits for what was held to go out, so that it can say how much went. */
export const NOTCH_ONLINE_WAIT_MS = 8000;
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
  /**
   * The connection is back: what waited for it can go on. When it comes back
   * with a number, that many things that were held have gone out, and the
   * line says so.
   */
  backOnline?(): void | number | Promise<number | void>;
  /**
   * Listening to the call (./call.ts). `offer` asks whether to, in the place
   * of "On a call. I hold everything", and comes back true when it has said
   * its own words. `ended` is the call being over: null when it was not
   * listened to, otherwise what came out of it is put on the notch, and what
   * was held comes after that.
   */
  listen?: {
    offer(stage: NotchStage, sidecarId: string): Promise<boolean>;
    ended(): Promise<void> | null;
    /** Whether this call is being listened to now. */
    listening?(): boolean;
    /** Whether listening could begin now. */
    can?(): boolean;
    /** Listening begins on the person's own press, with no question: Home's row for the call. */
    start?(stage: NotchStage, sidecarId: string): Promise<boolean>;
  };
  clock?: NotchClock;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NotchAround {
  /** Whether the person is on a call now, as far as is known. */
  onCall(): boolean;
  /** Whether the machine has a connection: false only when the desktop app said it has none. */
  online(): boolean;
  /**
   * Home's row about the call that is on, or null when none is. On a call
   * that is not listened to, the row is the way to have it listened to after
   * all: the question at its start is asked once, and not again at every tap.
   */
  callRow(): NotchBlock | null;
  /** What that row opens: listening to this call begins, by the press. */
  callOpen(stage: NotchStage): Promise<void>;
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
    // The hold keeps back what comes by itself, and nothing else: a tap on the resting notch still opens
    // Home, and what the person says or types is still taken. The question whether to listen is asked
    // once, at the start. (It used to be asked again at every tap, for the whole call: on a call the
    // owner had said no to, nothing else on the notch could be reached. 18 November 2026.)
    const hold = (): void => { if (inCall && !holding) { holding = true; inbox.hold(HOLD, { own: true }); parked = -1; park(); } };
    const say = (): void => {
      saying = null;
      if (!inCall || holding) return;
      if (deps.asleep?.()) { hold(); return; }
      const said = inbox.present('call', async (stage) => {
        try {
          // With the person's yes for this call, it is listened to and written down.
          const machine = from;
          const spoke = deps.listen && machine ? await deps.listen.offer(stage, machine) : false;
          if (!spoke && inCall) await stage.say(['On a call. I hold everything until you are done.'], 3000, { mood: 'focus' });
        } finally { hold(); }
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
    // A call that was listened to: what came out of it is said first, with everything else still held.
    let notes: Promise<void> | null = null;
    try { notes = deps.listen?.ended() ?? null; } catch (error) { log(`[notch] the end of a call that was listened to failed: ${error instanceof Error ? error.message : String(error)}`); }
    // It was never said, so nothing was held: the call came and went while the person was busy on the notch.
    if (!holding) { log('[notch] the call is over before it was said'); return; }
    holding = false;
    if (notes) { void notes.catch(() => {}).then(() => { if (!stopped) over(); }); return; }
    over();
  }

  /** The call is over and nothing more is said of it: what was held is offered. */
  function over(): void {
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
    const tell = saidOffline && !deps.asleep?.();
    saidOffline = false;
    // What was held goes out first, so that the line can say how much of it went: the prototype's
    // "Back online. 2 things I was holding went out." Not waited for long: the connection is back either way.
    const say = (went: number): void => {
      if (!tell) return;
      inbox.present('online', (stage) => stage.say(went > 0
        ? ['Back online. ', { em: went === 1 ? '1 thing' : `${went} things` }, ' I was holding went out.']
        : ['Back online.'], went > 0 ? 3400 : 2200, { mood: 'happy', mark: 'check' }));
    };
    let held: unknown;
    try { held = deps.backOnline?.(); } catch (error) { log(`[notch] going on after the connection came back failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (held instanceof Promise) {
      let said = false;
      const once = (went: number): void => { if (!said) { said = true; say(went); } };
      const late = clock.setTimeout(() => once(0), NOTCH_ONLINE_WAIT_MS);
      held.then((went) => { clock.clearTimeout(late); once(typeof went === 'number' && went > 0 ? Math.floor(went) : 0); }, () => { clock.clearTimeout(late); once(0); });
    } else {
      say(typeof held === 'number' && held > 0 ? Math.floor(held) : 0);
    }
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
    callRow() {
      // Before the call has been said there is nothing to say of it in Home either.
      if (!inCall || !holding) return null;
      if (deps.listen?.listening?.()) return { kind: 'row', lead: 'Call', say: ['I am listening to this call, and writing it down.'] };
      if (deps.listen?.start && from && deps.listen.can?.() !== false) return { kind: 'row', id: 'call', lead: 'Call', say: ['You are on a call. Listen and write it down'], go: true };
      return { kind: 'row', lead: 'Call', say: ['You are on a call. What comes by itself waits until it is over.'] };
    },
    async callOpen(stage) {
      const machine = from;
      if (!inCall || !machine || !deps.listen?.start) return;
      await deps.listen.start(stage, machine);
    },
    online: () => isOnline,
    stop: () => {
      stopped = true;
      for (const timer of [starting, ending, longest, parking, saying, goingOffline]) if (timer) clock.clearTimeout(timer);
      if (inCall) { inCall = false; surface.act({ park: 0 }); if (holding) inbox.release(HOLD); holding = false; }
    },
  };
}
