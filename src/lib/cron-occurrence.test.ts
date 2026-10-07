/**
 * Q-06: the scheduler fires each occurrence once and says which. System
 * crons (the morning briefing, goal windows) share it with workflows.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { CronScheduler, setCronTimezone, type CronOccurrence } from "./cron-scheduler";

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

  test("past the grace window an occurrence is reported missed, never run late", () => {
    setCronTimezone("UTC");
    const { fired, missed, tick } = job("0 9 * * *", "2026-10-07T08:59:00Z");
    tick("2026-10-07T09:02:30Z"); // asleep through 09:00
    expect(fired).toEqual([]);
    expect(missed).toEqual([{ at: at("2026-10-07T09:00:00Z"), key: "2026-10-07T09:00", lateMs: 150_000 }]);
  });
});
