/**
 * Tests for the `@every <duration>` sub-minute syntax added on top of the
 * stock 5-field cron parser. Exercises the parser bounds + that
 * `CronScheduler.schedule` actually fires at the requested interval.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { CronScheduler, parseEveryExpression } from "./cron";

describe("parseEveryExpression", () => {
  test("parses seconds / minutes / hours", () => {
    expect(parseEveryExpression("@every 10s")).toBe(10_000);
    expect(parseEveryExpression("@every 5m")).toBe(5 * 60_000);
    expect(parseEveryExpression("@every 2h")).toBe(2 * 60 * 60_000);
  });

  test("returns null for non-@every expressions (passes through to cron)", () => {
    expect(parseEveryExpression("* * * * *")).toBeNull();
    expect(parseEveryExpression("0 8 * * *")).toBeNull();
    expect(parseEveryExpression("not-a-cron")).toBeNull();
  });

  test("throws on out-of-bounds durations", () => {
    expect(() => parseEveryExpression("@every 0s")).toThrow();
    expect(() => parseEveryExpression("@every 25h")).toThrow();
  });

  test("case-insensitive on the @every keyword + unit", () => {
    expect(parseEveryExpression("@EVERY 10S")).toBe(10_000);
  });
});

describe("CronScheduler with @every syntax", () => {
  let scheduler: CronScheduler;

  afterEach(() => {
    scheduler?.cancelAll();
  });

  test("fires the callback at the requested sub-minute interval", async () => {
    scheduler = new CronScheduler();
    let fires = 0;
    scheduler.schedule("test:fast", "@every 1s", () => {
      fires++;
    });
    // Wait ~2.5s to capture at least 2 fires.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fires).toBeGreaterThanOrEqual(2);
  });

  test("cancel stops further fires", async () => {
    scheduler = new CronScheduler();
    let fires = 0;
    scheduler.schedule("test:cancel", "@every 1s", () => {
      fires++;
    });
    await new Promise((r) => setTimeout(r, 1_500));
    scheduler.cancel("test:cancel");
    const fixed = fires;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(fires).toBe(fixed);
  });

  test("getJobs() exposes the @every expression alongside cron jobs", () => {
    scheduler = new CronScheduler();
    scheduler.schedule("a", "@every 10s", () => {});
    scheduler.schedule("b", "* * * * *", () => {});
    const jobs = scheduler.getJobs();
    const a = jobs.find((j) => j.id === "a");
    const b = jobs.find((j) => j.id === "b");
    expect(a?.expression).toBe("@every 10s");
    expect(b?.expression).toBe("* * * * *");
    expect(a?.nextRun).toBeGreaterThan(Date.now());
  });
});
