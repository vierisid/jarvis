import type { BriefMeasurement } from "../../../../../src/brief/contracts";
import type { RecentActivityItem } from "../activity/RecentActivity";
import type { OutcomeBinding, OutcomeSummary } from "../outcomes/model";

const at = Date.parse("2026-09-17T07:00:00Z");
export function fixtureMeasurement(value: number, unit = "partners", target: number | null = 10): BriefMeasurement {
  return { value, unit, target, baseline: unit === "minutes" ? value + 15 : null, asOf: at,
    qualification: "measured", provenance: [{ kind: "receipt", id: "fixture-measurement-receipt", revision: "1" }] };
}
export function outcomeFixture(scenario = "ready", updated = false): OutcomeBinding {
  const data: OutcomeSummary = {
    window: { start: Date.parse("2026-09-14T00:00:00Z"), end: Date.parse("2026-09-21T00:00:00Z"), timezone: "Europe/Berlin" },
    today: fixtureMeasurement(90, "minutes", null), week: fixtureMeasurement(300, "minutes", null), chartMaxMinutes: 120,
    days: [45, 70, 95, 90].map((value, index) => ({ id: `fixture-day-${index}`, label: ["Mon", "Tue", "Wed", "Today"][index]!, current: index === 3, time: fixtureMeasurement(value, "minutes", null) })),
    goal: { goalId: "fixture-design-partners", title: "Win 10 design partners", progress: fixtureMeasurement(updated ? 7 : 6), change: fixtureMeasurement(updated ? 3 : 2, "partners", null), changeLabel: "partners", progressLabel: "design partners signed" },
    coverage: "complete", basis: "Illustrative manual-task baselines minus review time. Qualified completed work only; goal movement comes from separate signed-partner records. No live activity is represented.",
  };
  if (["loading", "empty"].includes(scenario)) return { source: "fixture", state: { status: scenario as "loading" | "empty" } };
  if (["unavailable", "unsupported"].includes(scenario)) return { source: "fixture", state: { status: scenario as "unavailable" | "unsupported", reason: "Outcome evidence is not available yet." } };
  if (scenario === "partial") { data.today = null; data.week = null; data.days = data.days.map((day, i) => ({ ...day, time: i === 1 ? null : day.time })); data.coverage = "partial"; }
  if (scenario === "unknown-goal") { data.goal!.progress = null; data.goal!.change = null; }
  if (scenario === "near-complete") { data.goal!.progress = fixtureMeasurement(updated ? 10 : 9); }
  if (scenario === "zero") { data.today = fixtureMeasurement(0, "minutes", null); data.week = fixtureMeasurement(0, "minutes", null); data.days = data.days.map(day => ({ ...day, time: fixtureMeasurement(0, "minutes", null) })); data.goal!.progress = fixtureMeasurement(0); data.goal!.change = fixtureMeasurement(0, "partners", null); }
  if (scenario === "long") { data.goal!.title = "Win design partners across the international pilot program"; data.goal!.changeLabel = "design partners across the international pilot program"; data.goal!.progressLabel = "design partners with a signed pilot agreement"; }
  return { source: "fixture", state: scenario === "stale" ? { status: "stale", data, reason: "Latest refresh unavailable" } : { status: "ready", data } };
}
export function activityFixture(scenario = "ready", actionable = false): OutcomeBinding<readonly RecentActivityItem[]> {
  if (["loading", "empty"].includes(scenario)) return { source: "fixture", state: { status: scenario as "loading" | "empty" } };
  if (["unavailable", "unsupported"].includes(scenario)) return { source: "fixture", state: { status: scenario as "unavailable" | "unsupported", reason: "Activity is unavailable." } };
  const data: RecentActivityItem[] = [
    { activityId: "fixture-inbox", title: "Inbox brief saved", timeLabel: "08:31", occurredAt: at - 29 * 60000, detail: "14 messages", destination: actionable ? { room: "workflow-runs", selection: { flowId: "fixture-inbox-flow", runId: "fixture-inbox-run" } } : undefined },
    { activityId: "fixture-notes", title: scenario === "long" ? "Meeting notes organised for the international design partnership discussion" : "Meeting notes organised", timeLabel: "09:02", occurredAt: at + 2 * 60000, detail: "Ready for your call" },
    { activityId: "fixture-follow-up", title: "Follow-up awaiting you", timeLabel: "09:14", occurredAt: at + 14 * 60000, detail: "Nothing sent" },
  ];
  return { source: "fixture", state: scenario === "stale" ? { status: "stale", data, reason: "Latest refresh unavailable" } : { status: "ready", data } };
}
