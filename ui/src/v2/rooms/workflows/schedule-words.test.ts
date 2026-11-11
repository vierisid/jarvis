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
    ["0 10 * * 0,6", "Every Saturday and Sunday at 10:00"],
    ["0 * * * *", "Every hour"],
    ["15 * * * *", "Every hour at minute 15"],
    ["0 */2 * * *", "Every 2 hours"],
    ["0 9,17 * * 1-5", "Every weekday at 9:00 and 17:00"],
    ["0 9 1,15 * *", "Monthly on days 1 and 15 at 9:00"],
    ["0 * * * 1-5", "Every hour on weekdays"],
    ["*/15 * * * 0,6", "Every 15 minutes on Saturdays and Sundays"],
    ["30 */2 * * 1", "Every 2 hours at minute 30 on Mondays"],
    ["0 8 * * 7", "Every Sunday at 8:00"],
  ])("%s reads as %s", (cron, words) => expect(cronToWords(cron)).toBe(words));

  test("what the scheduler refuses reads as no schedule: day names, ?, L, W and #", () => {
    // src/lib/cron-scheduler.ts parses numbers, lists, ranges and steps only (plus LW).
    for (const cron of ["0 8 * * MON-FRI", "0 8 * * mon", "0 8 ? * 1", "0 8 1 * ?", "0 8 L * *", "0 8 15W * *", "0 8 * * 5L", "0 8 * * 1#2"]) {
      expect(cronToWords(cron)).toBeNull();
      expect(parseSimpleCron(cron)).toBeNull();
    }
  });

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

describe("schedules that do not divide their period evenly", () => {
  test.each([
    ["*/59 * * * *", "At minutes 0 and 59 of every hour"],
    ["*/45 * * * *", "At minutes 0 and 45 of every hour"],
    ["*/7 * * * *", "At minutes 0, 7, 14, 21, 28, 35, 42, 49 and 56 of every hour"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 */7 * * *", "Every 7 hours from midnight (00:00, 07:00, 14:00, 21:00)"],
    ["0 */5 * * *", "Every 5 hours from midnight (00:00, 05:00, 10:00, 15:00, 20:00)"],
    ["30 */7 * * *", "Every 7 hours from 00:30 (00:30, 07:30, 14:30, 21:30)"],
    ["0 */6 * * *", "Every 6 hours"],
    ["0 */12 * * *", "Every 12 hours"],
  ])("%s reads as %s", (cron, words) => expect(cronToWords(cron)).toBe(words));

  test("days 29 to 31 say they skip short months", () => {
    expect(cronToWords("0 9 31 * *")).toBe("Monthly on day 31 of months that have one, at 9:00");
    expect(cronToWords("0 9 29 * *")).toBe("Monthly on day 29 of months that have one, at 9:00");
    expect(cronToWords("0 9 15,31 * *")).toBe("Monthly on days 15 and 31 (31 only in months that have it), at 9:00");
    expect(cronToWords("0 9 28 * *")).toBe("Monthly on day 28 at 9:00");
  });
});

describe("the catalog schedule piece reads like the built-in one", () => {
  // A zone counts only when a person chose it, as the trigger manager runs it.
  const catalog = (triggerName: string, input: Record<string, unknown>) => describeSchedule({
    pieceName: "@activepieces/piece-schedule", triggerName, input,
    ...(typeof input.timezone === "string" ? { chosenTimezone: input.timezone } : {}),
  });
  test("every_x_minutes, every_month and cron_expression", () => {
    expect(catalog("every_x_minutes", { minutes: 5 })).toBe("Every 5 minutes");
    expect(catalog("every_x_minutes", { minutes: 59 })).toBe("At minutes 0 and 59 of every hour");
    expect(catalog("every_x_minutes", { minutes: "45" })).toBe("At minutes 0 and 45 of every hour");
    expect(catalog("every_month", { day_of_the_month: 31, hour_of_the_day: 9, timezone: "Pacific/Kiritimati" }))
      .toBe("Monthly on day 31 of months that have one, at 9:00 (Pacific/Kiritimati)");
    expect(catalog("every_month", { day_of_the_month: 1, hour_of_the_day: 9, timezone: "UTC" })).toBe("Monthly on day 1 at 9:00 (UTC)");
    expect(catalog("cron_expression", { cronExpression: "30 2 * * *", timezone: "Europe/Rome" })).toBe("Every day at 2:30 (Europe/Rome)");
  });
  test("every_hour, every_day and every_week", () => {
    expect(catalog("every_hour", { run_on_weekends: true })).toBe("Every hour");
    expect(catalog("every_day", { hour_of_the_day: 8, run_on_weekends: false, timezone: "UTC" })).toBe("Every weekday at 8:00 (UTC)");
    expect(catalog("every_week", { day_of_the_week: 1, hour_of_the_day: 8, timezone: "UTC" })).toBe("Every Monday at 8:00 (UTC)");
  });
  test("a stored zone nobody chose is not shown: the manager runs it in Jarvis's zone", () => {
    const unchosen = (triggerName: string, input: Record<string, unknown>) => describeSchedule({ pieceName: "@activepieces/piece-schedule", triggerName, input });
    expect(unchosen("every_day", { hour_of_the_day: 9, run_on_weekends: true, timezone: "UTC" })).toBe("Every day at 9:00");
    expect(unchosen("cron_expression", { cronExpression: "0 9 * * 1-5", timezone: "UTC" })).toBe("Every weekday at 9:00");
    // The hourly triggers report UTC to the manager, so a chosen zone other than UTC is not used either.
    expect(describeSchedule({ pieceName: "@activepieces/piece-schedule", triggerName: "every_hour", input: { run_on_weekends: true, timezone: "Europe/Rome" }, chosenTimezone: "Europe/Rome" })).toBe("Every hour");
  });
  test("inputs read the way the piece reads them", () => {
    // validateHours turns anything but an integer into 0, and clamps; the checkbox is tested for truthiness.
    expect(catalog("every_day", { hour_of_the_day: "9", run_on_weekends: true })).toBe("Every day at 0:00");
    expect(catalog("every_day", { hour_of_the_day: 30, run_on_weekends: "yes" })).toBe("Every day at 23:00");
    expect(catalog("every_week", { day_of_the_week: 9, hour_of_the_day: 8 })).toBe("Every Saturday at 8:00");
    expect(catalog("every_hour", { run_on_weekends: false })).toBe("Every hour on weekdays");
    // */120 fires once an hour, at minute 0.
    expect(catalog("every_x_minutes", { minutes: 120 })).toBe("At minute 0 of every hour");
  });
  test("an unfilled trigger says it is not set yet", () => {
    expect(catalog("every_x_minutes", {})).toBe("On a schedule that is not set yet");
    expect(catalog("cron_expression", {})).toBe("On a schedule that is not set yet");
  });
});
