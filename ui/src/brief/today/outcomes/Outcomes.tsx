import React from "react";
import { BriefTooltip } from "../../components/controls";
import { useBriefReducedMotion } from "../../motion";
import { OutcomeNumber, GoalSegments } from "./Values";
import { outcomeView, qualified, qualifiedTime, qualifiedProgress, formatNumber, formatAsOf, weekTime, type OutcomeBinding, type OutcomeSummary } from "./model";
import "./outcomes.css";

export function OutcomeReadNotice({ status, reason }: { status: string; reason?: string }) {
  return <p className="brief-outcome-notice brief-type-body" role="status">{status === "loading" ? "Loading outcomes…"
    : status === "empty" ? "No completed work with outcome evidence yet."
    : reason || "Outcome evidence is not available yet."}</p>;
}
export function Outcomes({ mode, binding, reducedMotion = false }: { mode: "live" | "preview"; binding?: OutcomeBinding; reducedMotion?: boolean }) {
  const { state } = outcomeView(mode, binding);
  const reduced = useBriefReducedMotion(reducedMotion);
  const data = state.status === "ready" || state.status === "stale" ? state.data : null;
  return <section className="brief-outcome-panel brief-surface brief-surface--outcome" aria-label="Outcomes" data-state={state.status} data-reduced={reduced}>
    {!data ? <OutcomeReadNotice status={state.status} reason={"reason" in state ? state.reason : undefined} /> : <>
      {state.status === "stale" && <p className="brief-outcome-read-status brief-type-utility" role="status">Previously reported · {state.reason}</p>}
      {data.coverage === "partial" && <p className="brief-outcome-read-status brief-type-utility">Partial coverage</p>}
      <div className="brief-outcome-composition" key={`${data.window.start}:${data.window.end}:${data.window.timezone}`}>
        <div className="brief-outcome-time">
          {qualifiedTime(data.today) ? <>
            <div className="brief-outcome-time-value" style={{ "--value-digits": Math.max(2, formatNumber(data.today.value).length) } as React.CSSProperties}><strong><OutcomeNumber value={data.today.value} reducedMotion={reduced} /></strong><span>min</span></div>
            <p className="brief-type-body brief-secondary">saved today · estimated</p>
          </> : <div className="brief-outcome-missing"><strong>Time saved</strong><p>Not enough evidence yet</p></div>}
          <div className="brief-outcome-week">
            <div className="brief-outcome-bars" aria-label="Daily time saved">
              {data.days.map(day => <TimeBar key={day.id} day={day} maximum={data.chartMaxMinutes} />)}
            </div>
            <p className="brief-outcome-week-total brief-type-body-emphasis">{qualifiedTime(data.week) ? `${weekTime(data.week.value)} back this week` : "Weekly time not available"}</p>
          </div>
        </div>
        <div className="brief-outcome-goal" key={data.goal?.goalId ?? "no-goal"}>
          {!data.goal ? <div className="brief-outcome-missing"><strong>Goal movement</strong><p>No measured goal linked yet</p></div> : <>
            <div className="brief-outcome-delta" data-positive={qualified(data.goal.change) && data.goal.change.value > 0}>
              {qualified(data.goal.change) ? <strong><span>{data.goal.change.value > 0 ? "+" : ""}</span><OutcomeNumber value={data.goal.change.value} reducedMotion={reduced} /></strong> : <strong className="brief-outcome-unknown" aria-label="Weekly change unknown">—</strong>}
              <span className="brief-type-body">{data.goal.changeLabel}<small className="brief-secondary">this week</small></span>
            </div>
            <div className="brief-outcome-goal-progress">
              {qualifiedProgress(data.goal.progress) ? <>
                <div className="brief-outcome-fraction" style={{ "--goal-count-width": `${formatNumber(data.goal.progress.target).length}ch` } as React.CSSProperties}><strong><OutcomeNumber value={data.goal.progress.value} reducedMotion={reduced} /><span className="brief-outcome-denominator">/{formatNumber(data.goal.progress.target)}</span></strong></div>
                <p className="brief-type-body brief-secondary">{data.goal.progressLabel}</p>
                <GoalSegments value={data.goal.progress.value} target={data.goal.progress.target} label={`${formatNumber(data.goal.progress.value)} of ${formatNumber(data.goal.progress.target)} ${data.goal.progressLabel}`} reducedMotion={reduced} />
              </> : <div className="brief-outcome-missing"><strong>{data.goal.title}</strong><p>Progress not measured yet</p></div>}
            </div>
          </>}
        </div>
      </div>
      <OutcomeEvidence data={data} />
    </>}
  </section>;
}

function TimeBar({ day, maximum }: { day: OutcomeSummary["days"][number]; maximum: number }) {
  const known = qualifiedTime(day.time), scale = Number.isFinite(maximum) && maximum > 0 ? maximum : null;
  const value = known ? day.time!.value : null;
  const overflow = value !== null && scale !== null && value > scale;
  const label = `${day.label}: ${value === null ? "time not available" : `${formatNumber(value)} min saved · estimated`}${overflow ? " · above chart scale" : ""}`;
  return <BriefTooltip label={label}><button type="button" className="brief-outcome-bar-target" aria-label={label} data-current={day.current} data-known={known} data-overflow={overflow}>
    <span className="brief-outcome-bar-space" aria-hidden="true"><i className="brief-outcome-bar" style={{ height: value !== null && scale ? `${Math.min(1, value / scale) * 100}%` : 0 }} />
      {value === null || scale === null ? <span className="brief-outcome-bar-unknown">?</span> : overflow ? <span className="brief-outcome-bar-overflow">+</span> : null}</span>
    <span className="brief-type-utility brief-secondary">{day.label}</span>
  </button></BriefTooltip>;
}
function OutcomeEvidence({ data }: { data: OutcomeSummary }) {
  const metrics = [["Today", data.today], ["This week", data.week], ["Goal progress", data.goal?.progress], ["Weekly change", data.goal?.change]] as const;
  return <details className="brief-outcome-evidence"><summary>Data basis</summary>
    <div className="brief-type-utility"><p>{data.basis}</p><p>{data.coverage === "partial" ? "Incomplete coverage" : "Reported coverage complete"} · {data.window.timezone}</p>
      <p>{formatAsOf(data.window.start, data.window.timezone)} to {formatAsOf(data.window.end, data.window.timezone)}</p>
      <dl>{metrics.map(([label, measurement]) => <React.Fragment key={label}><dt>{label}</dt><dd>{(label === "Today" || label === "This week" ? qualifiedTime(measurement) : qualified(measurement)) && measurement
        ? `${measurement.qualification === "user_reported" ? "User reported" : "Measured"} · ${formatAsOf(measurement.asOf, data.window.timezone)} · ${measurement.provenance.length} evidence ${measurement.provenance.length === 1 ? "reference" : "references"}`
        : "No qualified measurement"}</dd></React.Fragment>)}</dl>
      {data.days.map(day => <p key={day.id}>{day.label}: {qualifiedTime(day.time) ? `${formatNumber(day.time.value)} min · estimated` : "No time evidence"}</p>)}
    </div>
  </details>;
}
