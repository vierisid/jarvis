/**
 * Q-06: the scheduler fires each occurrence once and says which. System
 * crons (the morning briefing, goal windows) share it with workflows.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { CronScheduler, setCronTimezone, type CronMissedSummary, type CronOccurrence } from "./cron-scheduler";

const at = (iso: string) => Date.parse(iso);
let scheduler: CronScheduler | null = null;
afterEach(() => { scheduler?.cancelAll(); scheduler = null; setSystemTime(); setCronTimezone(null); });

function job(expression: string, startIso: string) {
  setSystemTime(new Date(at(startIso)));
  scheduler = new CronScheduler();
  const fired: CronOccurrence[] = [];
  const missed: CronOccurrence[] = [];
  scheduler.schedule("j", expression, (o) => fired.push(o), { onMissed: (m) => missed.push(...m) });
  const tick = (iso: string) => scheduler!.runDue("j", at(iso));
  return { fired, missed, tick };
}

describe("CronScheduler occurrences", () => {
  test("each fires once, named by its wall-clock minute in the configured zone", () => {
    setCronTimezone("Asia/Kolkata");
    const { fired, tick } = job("0 9 * * *", "2026-10-07T03:29:00Z");
    tick("2026-10-07T03:30:10Z"); // 09:00 in Kolkata
    tick("2026-10-07T03:30:40Z");
    expect(fired).toEqual([{ at: at("2026-10-07T03:30:00Z"), key: "2026-10-07T09:00", lateMs: 10_000 }]);
  });

  test("the autumn hour that happens twice fires its minutes once", () => {
    setCronTimezone("America/New_York");
    const { fired, tick } = job("30 1 * * *", "2026-11-01T05:29:00Z");
    tick("2026-11-01T05:30:05Z");
    for (let m = 31; m <= 59; m++) tick(`2026-11-01T05:${m}:05Z`);
    for (let m = 0; m <= 31; m++) tick(`2026-11-01T06:${String(m).padStart(2, "0")}:05Z`);
    expect(fired.map(o => o.key)).toEqual(["2026-11-01T01:30"]);
  });

  test("a clock stepped back does not fire a minute again, nor run one it had missed", () => {
    setCronTimezone("UTC");
    const fresh = job("0 9 * * *", "2026-10-07T08:59:30Z");
    fresh.tick("2026-10-07T09:00:10Z");
    fresh.tick("2026-10-07T08:59:50Z"); // NTP stepped the clock back
    fresh.tick("2026-10-07T09:00:20Z");
    expect(fresh.fired).toHaveLength(1);
    scheduler?.cancelAll();
    const late = job("0 9 * * *", "2026-10-07T08:59:30Z");
    late.tick("2026-10-07T09:03:00Z"); // asleep through 09:00: missed
    late.tick("2026-10-07T08:59:50Z"); // then the clock is stepped back past it
    late.tick("2026-10-07T09:00:20Z");
    expect(late.missed).toHaveLength(1);
    expect(late.fired).toEqual([]);
  });

  test("a clock corrected far back carries on from the new time, firing nothing twice", () => {
    setCronTimezone("UTC");
    const { fired, tick } = job("*/15 * * * *", "2026-10-07T09:59:30Z"); // the host runs an hour fast
    tick("2026-10-07T10:00:10Z");
    tick("2026-10-07T10:15:10Z");
    tick("2026-10-07T09:20:10Z"); // corrected
    for (const iso of ["09:30:10", "09:45:10", "10:00:10", "10:15:10", "10:30:10"]) tick(`2026-10-07T${iso}Z`);
    expect(fired.map(o => o.key.slice(11))).toEqual(["10:00", "10:15", "09:30", "09:45", "10:30"]);
  });

  test("after a long sleep the newest 100 missed times are listed, older ones counted, and the times still due run", () => {
    setCronTimezone("UTC");
    setSystemTime(new Date(at("2026-10-07T09:00:00Z")));
    scheduler = new CronScheduler();
    const fired: string[] = [];
    let listed: CronOccurrence[] = [];
    let older: CronMissedSummary | undefined;
    scheduler.schedule("j", "* * * * *", (o) => fired.push(o!.key), { onMissed: (m, rest) => { listed = m; older = rest; } });
    scheduler.runDue("j", at("2026-10-07T09:00:10Z"));
    scheduler.runDue("j", at("2026-10-08T05:00:30Z")); // asleep for twenty hours
    expect(fired).toEqual(["2026-10-07T09:00", "2026-10-08T04:59", "2026-10-08T05:00"]);
    expect([listed.length, listed[0]!.key, listed[99]!.key]).toEqual([100, "2026-10-08T03:19", "2026-10-08T04:58"]);
    expect(older).toEqual({ count: 1_098, from: at("2026-10-07T09:01:00Z"), through: at("2026-10-08T03:18:00Z") });
  });

  test("past the grace window an occurrence is reported missed, never run late", () => {
    setCronTimezone("UTC");
    const { fired, missed, tick } = job("0 9 * * *", "2026-10-07T08:59:00Z");
    tick("2026-10-07T09:02:30Z"); // asleep through 09:00
    expect(fired).toEqual([]);
    expect(missed).toEqual([{ at: at("2026-10-07T09:00:00Z"), key: "2026-10-07T09:00", lateMs: 150_000 }]);
  });
});

describe("CronScheduler tick cadence", () => {
  // Runs the scheduler's real interval on a simulated clock: whatever period it
  // asked setInterval for is the period the clock advances by.
  function simulate(expression: string, startIso: string, endIso: string, startOffsetMs = 0) {
    let clock = at(startIso) + startOffsetMs;
    const realSetInterval = globalThis.setInterval;
    let periodMs = 0;
    let beat: (() => void) | null = null;
    (globalThis as any).setInterval = (fn: () => void, ms: number) => { periodMs = ms; beat = fn; return 0 as any; };
    const fired: CronOccurrence[] = [];
    try {
      scheduler = new CronScheduler(() => clock);
      scheduler.schedule("j", expression, (o) => fired.push(o));
    } finally { globalThis.setInterval = realSetInterval; }
    for (const end = at(endIso); clock < end; clock += periodMs) beat!();
    return { fired, periodMs };
  }

  test("a time starts within two seconds of its minute whatever the registration offset", () => {
    setCronTimezone("UTC");
    for (const offset of [0, 7_000, 25_000, 29_000]) {
      const { fired } = simulate("0 9 * * *", "2026-10-07T08:59:00Z", "2026-10-07T09:01:00Z", offset);
      expect(fired.map(o => o.key)).toEqual(["2026-10-07T09:00"]);
      expect(fired[0]!.lateMs).toBeLessThanOrEqual(2_000);
    }
  });

  test("consecutive minute fires do not drift", () => {
    setCronTimezone("UTC");
    const { fired } = simulate("*/1 * * * *", "2026-10-07T08:59:00Z", "2026-10-07T09:20:00Z", 17_000);
    // The first is the registration minute, run on registration by design.
    const after = fired.slice(1);
    expect(after.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...after.map(o => o.lateMs))).toBeLessThanOrEqual(2_000);
  });
});

describe("CronScheduler ticker", () => {
  // Counts the intervals the scheduler holds open, without letting any run.
  function counting() {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const live = new Map<number, () => void>();
    let next = 1;
    (globalThis as any).setInterval = (fn: () => void) => { live.set(next, fn); return next++ as any; };
    (globalThis as any).clearInterval = (handle: number) => { live.delete(handle); };
    return { live, restore: () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; } };
  }

  test("many schedules share one timer, which stops with the last of them", () => {
    setCronTimezone("UTC");
    const timers = counting();
    try {
      scheduler = new CronScheduler(() => at("2026-10-07T08:59:30Z"));
      for (let i = 0; i < 50; i++) scheduler.schedule(`j${i}`, `${i % 60} * * * *`, () => {});
      expect(timers.live.size).toBe(1);
      for (let i = 0; i < 49; i++) scheduler.cancel(`j${i}`);
      expect(timers.live.size).toBe(1);
      scheduler.cancel("j49");
      expect(timers.live.size).toBe(0);
      scheduler.schedule("again", "* * * * *", () => {});
      expect(timers.live.size).toBe(1);
      scheduler.cancelAll();
      expect(timers.live.size).toBe(0);
    } finally { timers.restore(); }
  });

  test("one pass ticks every job and skips one cancelled earlier in the pass", () => {
    setCronTimezone("UTC");
    let clock = at("2026-10-07T08:59:30Z");
    const timers = counting();
    const fired: string[] = [];
    try {
      scheduler = new CronScheduler(() => clock);
      scheduler.schedule("a", "0 9 * * *", () => { fired.push("a"); scheduler!.cancel("b"); });
      scheduler.schedule("b", "0 9 * * *", () => fired.push("b"));
      scheduler.schedule("c", "0 9 * * *", () => fired.push("c"));
      const [beat] = Array.from(timers.live.values());
      clock = at("2026-10-07T09:00:01Z");
      beat!();
      expect(fired).toEqual(["a", "c"]);
    } finally { timers.restore(); }
  });

  test("after a laptop sleep the first tick on waking runs the time still in grace and reports the rest", () => {
    setCronTimezone("UTC");
    let clock = at("2026-10-07T07:00:00Z");
    const timers = counting();
    const fired: CronOccurrence[] = [];
    const missed: CronOccurrence[] = [];
    try {
      scheduler = new CronScheduler(() => clock);
      scheduler.schedule("j", "0 * * * *", (o) => fired.push(o), { onMissed: (m) => missed.push(...m) });
      const [beat] = Array.from(timers.live.values());
      clock = at("2026-10-07T07:00:01Z"); beat!();
      // Asleep from 07:00:01 until 10:01:30; the timer resumes with the host.
      clock = at("2026-10-07T10:01:30Z"); beat!();
      clock = at("2026-10-07T10:01:31Z"); beat!();
      expect(fired.map((o) => o.key)).toEqual(["2026-10-07T07:00", "2026-10-07T10:00"]);
      expect(fired[1]!.lateMs).toBe(90_000);
      expect(missed.map((o) => o.key)).toEqual(["2026-10-07T08:00", "2026-10-07T09:00"]);
    } finally { timers.restore(); }
  });
});
