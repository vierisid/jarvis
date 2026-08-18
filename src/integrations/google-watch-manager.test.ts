import { describe, expect, test } from 'bun:test';
import { GoogleWatchManager, type WatchApi } from './google-watch-manager.ts';
import type { GoogleAuth } from './google-auth.ts';
import { GMAIL_WATCH_RENEW_MS, type CalendarChannel } from './google-watch.ts';

/**
 * The watch lifecycle (GOOGLE.md "Push bridging").
 *
 * Everything here is invisible in production until it is wrong, and then it is
 * wrong quietly: push simply stops working while polling keeps the product
 * looking fine. The two rules that matter most are that a Calendar
 * re-registration STOPS the previous channel (Google fans every change out to
 * every live channel, so leaking them multiplies the traffic for one instance),
 * and that a FAILED attempt still re-arms (otherwise one transient refusal
 * disables push until the next daemon restart).
 */
const TOPIC = 'projects/p/topics/gmail-push';
const CALLBACK = 'https://app.example.com/api/integrations/google/push';
const CHANNEL_TOKEN = 'inst-1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fakeAuth(authenticated = true): GoogleAuth {
  return {
    isAuthenticated: () => authenticated,
    getAccessToken: async () => 'ya29.token',
  } as unknown as GoogleAuth;
}

/** Records every call, and hands back the scheduled renewals to fire by hand. */
function fakeApi(over: Partial<WatchApi> = {}) {
  const calls: string[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  let channelSeq = 0;
  const stoppedChannels: string[] = [];
  const api: WatchApi = {
    registerGmail: async (_t, topic) => {
      calls.push(`registerGmail:${topic}`);
      return { expiration: undefined };
    },
    stopGmail: async () => {
      calls.push('stopGmail');
    },
    registerCalendar: async (_t, input) => {
      channelSeq += 1;
      calls.push(`registerCalendar:${input.channelToken}`);
      return { id: `chan-${channelSeq}`, resourceId: `res-${channelSeq}` } as CalendarChannel;
    },
    stopCalendar: async (_t, channel) => {
      calls.push(`stopCalendar:${channel.id}`);
      stoppedChannels.push(channel.id);
    },
    schedule: (fn, ms) => {
      const entry = { fn, ms };
      scheduled.push(entry);
      // cancel() really removes it, so `scheduled` is the set of timers that
      // would ACTUALLY fire. A no-op cancel would let a leaked or provisional
      // timer pass unnoticed, which is half of what these tests are for.
      return {
        cancel: () => {
          const i = scheduled.indexOf(entry);
          if (i >= 0) scheduled.splice(i, 1);
        },
      };
    },
    ...over,
  };
  return { api, calls, scheduled, stoppedChannels };
}

const allTargets = { pubsubTopic: TOPIC, pushCallback: CALLBACK, channelToken: CHANNEL_TOKEN };

describe('GoogleWatchManager', () => {
  test('arms both watches when everything is configured', async () => {
    const { api, calls, scheduled } = fakeApi();
    const m = new GoogleWatchManager(api);
    m.configure(fakeAuth(), allTargets);
    expect(m.enabled).toBe(true);
    await m.start();

    expect(calls).toContain(`registerGmail:${TOPIC}`);
    expect(calls).toContain(`registerCalendar:${CHANNEL_TOKEN}`);
    // Both re-arm themselves; a watch registered once and never renewed silently
    // stops working within days.
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]!.ms).toBe(GMAIL_WATCH_RENEW_MS);
  });

  test('nothing is armed without auth, or without any target', async () => {
    const { api, calls } = fakeApi();

    const noAuth = new GoogleWatchManager(api);
    noAuth.configure(fakeAuth(false), allTargets);
    expect(noAuth.enabled).toBe(false);
    await noAuth.start();

    // Self-hosted: no bridge at all. Polling covers everything, so this must be
    // silent rather than an error.
    const noTargets = new GoogleWatchManager(api);
    noTargets.configure(fakeAuth(), {});
    expect(noTargets.enabled).toBe(false);
    await noTargets.start();

    expect(calls).toEqual([]);
  });

  test('a topic alone arms Gmail; a callback alone arms Calendar', async () => {
    const gmailOnly = fakeApi();
    const g = new GoogleWatchManager(gmailOnly.api);
    g.configure(fakeAuth(), { pubsubTopic: TOPIC });
    await g.start();
    expect(gmailOnly.calls).toEqual([`registerGmail:${TOPIC}`]);

    const calOnly = fakeApi();
    const c = new GoogleWatchManager(calOnly.api);
    c.configure(fakeAuth(), { pushCallback: CALLBACK, channelToken: CHANNEL_TOKEN });
    await c.start();
    expect(calOnly.calls).toEqual([`registerCalendar:${CHANNEL_TOKEN}`]);

    // A callback with no channel token cannot be routed back by the bridge, so
    // registering it would produce notifications nobody can attribute.
    const halfCal = fakeApi();
    const h = new GoogleWatchManager(halfCal.api);
    h.configure(fakeAuth(), { pushCallback: CALLBACK });
    expect(h.enabled).toBe(false);
    await h.start();
    expect(halfCal.calls).toEqual([]);
  });

  test('a Calendar RENEWAL stops the previous channel first', async () => {
    const { api, calls, scheduled } = fakeApi();
    const m = new GoogleWatchManager(api);
    m.configure(fakeAuth(), { pushCallback: CALLBACK, channelToken: CHANNEL_TOKEN });
    await m.start();
    expect(calls).toEqual([`registerCalendar:${CHANNEL_TOKEN}`]);

    // Fire the scheduled renewal by hand. Each registration creates a NEW
    // channel, so without stopping the old one Google ends up delivering every
    // change to a growing pile of channels that all point at this one instance.
    const renew = scheduled.at(-1)!;
    renew.fn();
    await Bun.sleep(0);

    expect(calls).toEqual([
      `registerCalendar:${CHANNEL_TOKEN}`,
      'stopCalendar:chan-1',
      `registerCalendar:${CHANNEL_TOKEN}`,
    ]);
  });

  test('a FAILED registration still re-arms', async () => {
    const { api, calls, scheduled } = fakeApi({
      registerGmail: async () => {
        calls.push('registerGmail:refused');
        return null;
      },
    });
    const m = new GoogleWatchManager(api);
    m.configure(fakeAuth(), { pubsubTopic: TOPIC });
    await m.start();

    // The timer IS the retry. Giving up here would disable push until the next
    // daemon restart, for what may have been a transient refusal.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(GMAIL_WATCH_RENEW_MS);
    scheduled[0]!.fn();
    await Bun.sleep(0);
    expect(calls.filter((c) => c === 'registerGmail:refused')).toHaveLength(2);
  });

  test('a failed TOKEN re-arms too, not just a failed registration', async () => {
    // The regression this pins: the retry used to be scheduled only AFTER the
    // token was in hand, so "could not get an access token" returned early and
    // scheduled nothing — push off until the next daemon restart. Under managed
    // refresh the control plane is a hard dependency, so a momentary failure
    // here is ordinary, and it is likeliest at boot when this first runs.
    const { api, calls, scheduled } = fakeApi();
    let working = false;
    const auth = {
      isAuthenticated: () => true,
      getAccessToken: async () => {
        if (!working) throw new Error('control plane unreachable');
        return 'ya29.token';
      },
    } as unknown as GoogleAuth;

    const m = new GoogleWatchManager(api);
    m.configure(auth, allTargets);
    await m.start();

    expect(calls).toHaveLength(0);
    expect(scheduled).toHaveLength(2);

    working = true;
    for (const t of scheduled.slice()) t.fn();
    await Bun.sleep(0);
    expect(calls).toContain(`registerGmail:${TOPIC}`);
    expect(calls).toContain(`registerCalendar:${CHANNEL_TOKEN}`);
  });

  test('a stop during an in-flight registration undoes the watch it created', async () => {
    // THE leak: start() does not await the manager (observer-service fires it
    // with `void`), so an arm can still be inside registerCalendar when the user
    // disconnects. It then assigned the channel and armed a timer on a stopped
    // manager — and no later stop() could cancel that channel, because a
    // disconnect deletes the tokens file first, so there is no token left to call
    // Google with. Google kept pushing that user's calendar for the channel's
    // whole TTL.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { api, calls, scheduled } = fakeApi();
    const m = new GoogleWatchManager({
      ...api,
      registerCalendar: async (t, input) => {
        await gate;
        return api.registerCalendar(t, input);
      },
      registerGmail: async (t, topic) => {
        await gate;
        return api.registerGmail(t, topic);
      },
    });
    m.configure(fakeAuth(), allTargets);

    const starting = m.start();
    await Bun.sleep(0);
    await m.stop();
    release();
    await starting;

    // Whatever was registered was stopped again, and nothing is left armed.
    expect(calls).toContain('registerCalendar:' + CHANNEL_TOKEN);
    expect(calls).toContain('stopCalendar:chan-1');
    expect(calls.filter((c) => c === 'stopGmail')).not.toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  test('a stop/start race leaves exactly one live channel and one live timer', async () => {
    // The daemon's google applier stops then starts the observers without
    // awaiting the manager, so two arms can overlap. The older one used to assign
    // its channel over the newer one's — orphaning a channel nothing holds a
    // reference to, so Google fanned every change out to two channels for one
    // instance — and to overwrite the newer one's timer field, leaving a live but
    // unreachable timer re-arming forever.
    let gate1: () => void = () => {};
    const first = new Promise<void>((r) => { gate1 = r; });
    let seen = 0;
    const { api, calls, scheduled, stoppedChannels } = fakeApi();
    const m = new GoogleWatchManager({
      ...api,
      registerCalendar: async (t, input) => {
        seen += 1;
        if (seen === 1) await first;
        return api.registerCalendar(t, input);
      },
    });
    m.configure(fakeAuth(), allTargets);

    const firstStart = m.start();
    await Bun.sleep(0);
    await m.stop();
    await m.start();
    gate1();
    await firstStart;

    // Two registrations happened, and exactly one channel was stopped: the one
    // belonging to the arm that lost. WHICH id that is depends on the order the
    // two arms reached Google, which is not the point — the point is that no
    // channel is left with nobody holding a reference to it.
    expect(calls.filter((c) => c.startsWith('registerCalendar')).length).toBe(2);
    expect(stoppedChannels).toHaveLength(1);
    // One Gmail timer + one Calendar timer, from the surviving generation only.
    expect(scheduled).toHaveLength(2);
  });

  test('stop() cancels the renewals and tells Google to stop', async () => {
    const { api, calls, scheduled } = fakeApi();
    const m = new GoogleWatchManager(api);
    m.configure(fakeAuth(), allTargets);
    await m.start();
    const live = scheduled.slice();
    await m.stop();

    // Counting cancel() calls would pass on a manager that cancelled the same
    // timer twice and leaked the other; what matters is that NO timer is left
    // live.
    expect(live).toHaveLength(2);
    expect(scheduled).toHaveLength(0);
    expect(calls).toContain('stopGmail');
    expect(calls).toContain('stopCalendar:chan-1');

    // And a renewal that fires AFTER stop must do nothing — a cancelled timer
    // that still runs (or a queued callback already in flight) must not
    // resurrect a watch for observers that are no longer running.
    const before = calls.length;
    live.at(-1)!.fn();
    await Bun.sleep(0);
    expect(calls).toHaveLength(before);
  });

  test('stop() is silent when the tokens are already gone', async () => {
    // THE disconnect path: revoke-google deletes the tokens file before the
    // reload applier stops the observers, so there is no access token left to
    // call Google with. Nothing to do, and nothing to throw about — the bridge
    // dropping unroutable notifications is the real backstop.
    const { api, calls } = fakeApi();
    const m = new GoogleWatchManager(api);
    m.configure(fakeAuth(), allTargets);
    await m.start();
    calls.length = 0;
    m.configure(fakeAuth(false), allTargets); // tokens gone
    await m.stop();
    expect(calls).toEqual([]);
  });

  test('start() twice does not double-register', async () => {
    // The reload applier stops and starts the observer service on every google
    // change; a second start without a stop must not arm a second set of
    // watches (which for Calendar would mean a duplicate channel).
    const { api, calls } = fakeApi();
    const m = new GoogleWatchManager(api);
    m.configure(fakeAuth(), allTargets);
    await m.start();
    const after = calls.length;
    await m.start();
    expect(calls).toHaveLength(after);
  });
});
