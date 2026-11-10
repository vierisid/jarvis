import { describe, expect, test } from "bun:test";
import { buildSimpleCron, cronToWords, describeSchedule, parseSimpleCron } from "./schedule-words";

describe("cronToWords", () => {
  test.each([
    ["0 9 * * 1-5", "Every weekday at 9:00"],
    ["30 8 * * 5", "Every Friday at 8:30"],
    ["*/5 * * * *", "Every 5 minutes"],
    ["* * * * *", "Every minute"],
    ["0 9 1 * *", "Monthly on day 1 at 9:00"],
    ["0 9 * * *", "Every day at 9:00"],
    ["0 9 * * 1,3,5", "Every Monday, Wednesday and Friday at 9:00"],
    ["0 10 * * 0,6", "Every weekend at 10:00"],
    ["0 * * * *", "Every hour"],
    ["15 * * * *", "Every hour at minute 15"],
    ["0 */2 * * *", "Every 2 hours"],
    ["0 9,17 * * 1-5", "Every weekday at 9:00 and 17:00"],
    ["0 9 1,15 * *", "Monthly on days 1 and 15 at 9:00"],
    ["0 8 * * MON-FRI", "Every weekday at 8:00"],
    ["0 8 * * 7", "Every Sunday at 8:00"],
  ])("%s reads as %s", (cron, words) => expect(cronToWords(cron)).toBe(words));

  test("shapes with no plain form return null instead of a wrong sentence", () => {
    for (const cron of ["0 17 LW * *", "0 9 1 6 *", "0 9 1 * 1", "0 0 9 * * *", "nonsense", "", "61 9 * * *", "0 25 * * *"]) {
      expect(cronToWords(cron)).toBeNull();
    }
  });
});

describe("describeSchedule", () => {
  test("adds the zone only when a person chose it", () => {
    const input = { cron_expression: "0 9 * * 1-5", timezone: "Europe/Rome" };
    expect(describeSchedule({ input, chosenTimezone: "Europe/Rome" })).toBe("Every weekday at 9:00 (Europe/Rome)");
    // A pre-filled zone nobody chose is not what the scheduler uses.
    expect(describeSchedule({ input })).toBe("Every weekday at 9:00");
  });
  test("falls back to the raw expression, and says so when nothing is set", () => {
    expect(describeSchedule({ input: { cron_expression: "0 17 LW * *" } })).toBe("On a custom schedule (0 17 LW * *)");
    expect(describeSchedule({ input: {} })).toBe("On a schedule that is not set yet");
  });
});

describe("simple schedule shapes", () => {
  test("build and parse agree for every simple shape", () => {
    expect(buildSimpleCron({ mode: "daily", hour: 9, minute: 0, days: [] })).toBe("0 9 * * *");
    expect(buildSimpleCron({ mode: "weekdays", hour: 9, minute: 0, days: [] })).toBe("0 9 * * 1-5");
    expect(buildSimpleCron({ mode: "days", hour: 8, minute: 30, days: [5] })).toBe("30 8 * * 5");
    expect(buildSimpleCron({ mode: "days", hour: 8, minute: 30, days: [5, 1, 0] })).toBe("30 8 * * 0,1,5");
    for (const cron of ["0 9 * * *", "0 9 * * 1-5", "30 8 * * 5", "30 8 * * 0,1,5"]) {
      const parsed = parseSimpleCron(cron)!;
      expect(buildSimpleCron(parsed)).toBe(cron);
    }
    expect(parseSimpleCron("0 9 * * 1,2,3,4,5")?.mode).toBe("weekdays");
  });
  test("expressions the simple editor cannot express are left to Custom", () => {
    for (const cron of ["*/5 * * * *", "0 9 1 * *", "0 9,17 * * *", "0 17 LW * *", ""]) expect(parseSimpleCron(cron)).toBeNull();
  });
});
