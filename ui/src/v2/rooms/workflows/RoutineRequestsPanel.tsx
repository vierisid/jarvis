import React, { useEffect, useRef, useState } from "react";
import { Button, Chip } from "../../ui";
import type { SuggestionLearning } from "../../../../../src/awareness/suggestion-feedback";
import "./RoutineRequestsPanel.css";

type Page = { suggestions: SuggestionLearning[]; nextOffset: number | null };
type Goal = { id: string; title: string };

async function readJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not save this request. Please retry.");
  return result as T;
}

function status(learning: SuggestionLearning): string {
  if (learning.status === "dismissed") return "Dismissed";
  const job = learning.composition;
  if (!job) return "Proposed";
  if (job.draftAvailable === false) return "Draft deleted";
  return { queued: "Waiting", running: "Creating", failed: "Needs attention", draft_ready: "Draft ready" }[job.state];
}

/** Used by both the dashboard Workflows room and its standalone panel. */
export function RoutineRequestsPanel({ onReview }: { onReview: (flowId: string) => void }): React.ReactElement {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await readJson<Page>(`/api/awareness/routines?offset=${offset}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPage(result);
        setSelected(id => id ?? result.suggestions[0]?.opportunityId ?? null);
        setError("");
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load routine requests.");
      } finally { fetching = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [offset, revision]);

  const learning = page?.suggestions.find(item => item.opportunityId === selected);
  const update = (item: SuggestionLearning) => {
    // Apply the saved result immediately; then replace any older in-flight poll.
    setPage(previous => previous && ({ ...previous,
      suggestions: previous.suggestions.map(row => row.opportunityId === item.opportunityId ? item : row) }));
    refresh();
  };
  const changePage = (value: number) => { setOffset(value); setSelected(null); setPage(null); };

  return <section className="wf-routines" aria-label="Routine requests">
    <div className="wf-routines__toolbar">
      <p>Review proposed routines and return to saved draft requests here.</p>
      <Button size="sm" onClick={refresh}>Refresh requests</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!page ? !error && <p role="status">Loading routine requests…</p> : page.suggestions.length === 0 ?
      <div><p>{offset > 0 ? "No older requests." : "No routine requests yet. Proposals appear here when Jarvis notices recurring work."}</p>
        {offset > 0 && <Button size="sm" onClick={() => changePage(Math.max(0, offset - 100))}>Newer requests</Button>}
      </div> :
      <div className="wf-routines__layout">
        <div>
          <ul className="wf-routines__list" aria-label="Saved proposals and requests">
            {page.suggestions.map(item => <li key={item.opportunityId}>
              <button className="wf-routines__row" aria-pressed={selected === item.opportunityId}
                onClick={() => setSelected(item.opportunityId)}>
                <span>{item.composition?.request.name ?? item.title}</span>
                <Chip tone={item.composition?.state === "failed" ? "warn" : "neutral"}>{status(item)}</Chip>
              </button>
            </li>)}
          </ul>
          <div className="wf-routines__actions">
            {offset > 0 && <Button size="sm" onClick={() => changePage(Math.max(0, offset - 100))}>Newer requests</Button>}
            {page.nextOffset !== null && <Button size="sm" onClick={() => changePage(page.nextOffset!)}>Older requests</Button>}
          </div>
        </div>
        {learning ? <RoutineDetail key={learning.opportunityId} learning={learning} onSaved={update} onReview={onReview} /> :
          <p>Select a request to inspect it.</p>}
      </div>}
  </section>;
}

function RoutineDetail({ learning, onSaved, onReview }: {
  learning: SuggestionLearning; onSaved: (item: SuggestionLearning) => void; onReview: (flowId: string) => void;
}): React.ReactElement {
  const [mode, setMode] = useState<"draft" | "dismiss" | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalId, setGoalId] = useState("");
  const [goalError, setGoalError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const job = learning.composition;

  useEffect(() => {
    if (mode !== "draft") return;
    const controller = new AbortController();
    readJson<Goal[]>("/api/goals?status=active", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setGoals(value); setGoalError(""); } })
      .catch(() => { if (!controller.signal.aborted) setGoalError("Goals could not be loaded. You can continue without a goal link."); });
    return () => controller.abort();
  }, [mode]);

  const save = async (action: "accept" | "dismiss" | "retry", values: Record<string, unknown>) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    const key = JSON.stringify({ action, values });
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    try {
      const result = await readJson<SuggestionLearning | { learning: SuggestionLearning }>(
        `/api/awareness/suggestions/${encodeURIComponent(learning.opportunityId)}/${action}`, {
          method: action === "dismiss" ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...values, requestId: request.current.id }),
        });
      request.current = null; setMode(null);
      onSaved("learning" in result ? result.learning : result);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save. Please retry."); }
    finally { saving.current = false; setBusy(false); }
  };

  return <section className="wf-routines__detail" aria-label="Selected routine request">
    <h3>{learning.title}</h3>
    <p>{learning.body}</p>
    <details>
      <summary>Observations ({learning.observations.length})</summary>
      {learning.observations.length ? <ul>{learning.observations.map((observation, index) =>
        <li key={`${observation.captureId}:${index}`}>
          {observation.app && <strong>{observation.app}: </strong>}{observation.cue || "Recorded activity"}
          {observation.observedAt ? ` · ${new Date(observation.observedAt).toLocaleString()}` : ""}
          <small>Capture reference: {observation.captureId}</small>
        </li>)}</ul> : <p>No retained observations are available.</p>}
    </details>
    {job && <>
      <dl><dt>Recurring job</dt><dd>{job.request.description}</dd>
        <dt>Useful result</dt><dd>{job.request.expectedOutcome}</dd>
        {learning.goalLink && <><dt>Related goal</dt><dd>{learning.goalLink.title}: {learning.goalLink.reason}</dd></>}
      </dl>
      <p role="status">{job.state === "queued" ? "Your request is saved and waiting to compose." :
        job.state === "running" ? "Creating your draft. You can leave and return to this request." :
        job.state === "failed" ? job.error || "Composition failed. Your request is saved." :
        job.draftAvailable === false ? "The attached draft was deleted. Your request and feedback are retained." :
        "Your draft is ready for review before publishing or running it."}</p>
      <div className="wf-routines__actions">
        {job.state === "failed" && learning.status !== "dismissed" &&
          <Button disabled={busy} onClick={() => void save("retry", { reason: "Requested another composition attempt" })}>
            {busy ? "Saving…" : "Retry composition"}</Button>}
        {job.state === "draft_ready" && job.draftAvailable && job.workflowId &&
          <Button variant="primary" onClick={() => onReview(job.workflowId!)}>Review draft</Button>}
      </div>
    </>}
    {!job && learning.status !== "dismissed" && <>
      {!mode ? <div className="wf-routines__actions">
        <Button variant="primary" onClick={() => setMode("draft")}>Draft a routine</Button>
        <Button onClick={() => setMode("dismiss")}>Dismiss proposal</Button>
      </div> : <form key={mode} className="wf-routines__form" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (mode === "dismiss") { void save("dismiss", { reason: data.get("reason") }); return; }
        void save("accept", { name: data.get("name"), description: data.get("description"), expectedOutcome: data.get("expectedOutcome"),
          goalId: goalId || null, goalReason: goalId ? data.get("goalReason") : null,
          reason: "Confirmed the recurring job and requested a workflow draft" });
      }}>
        <fieldset disabled={busy}>
          {mode === "draft" ? <>
            <label>Routine name<input name="name" required maxLength={200} defaultValue={learning.title} /></label>
            <label>What recurring job should it do?<textarea name="description" required maxLength={4000} /></label>
            <label>What result would be useful?<textarea name="expectedOutcome" required maxLength={1000} /></label>
            <label>Related goal (optional)<select name="goalId" value={goalId} onChange={event => setGoalId(event.target.value)}>
              <option value="">No goal link</option>{goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
            </select></label>
            {goalId && <label>Why does it support that goal?<input name="goalReason" required maxLength={1000} /></label>}
            {goalError && <p role="status">{goalError}</p>}
            <p>This creates a disabled draft for your review.</p>
          </> : <label>Why is this proposal not useful?<textarea name="reason" required maxLength={1000} /></label>}
          <div className="wf-routines__actions">
            <Button type="submit" variant="primary">{busy ? "Saving…" : mode === "draft" ? "Create draft" : "Save dismissal"}</Button>
            <Button onClick={() => { setMode(null); setError(""); }}>Cancel</Button>
          </div>
        </fieldset>
      </form>}
    </>}
    {error && <p role="alert">{error}</p>}
    {learning.feedback.length > 0 && <details><summary>Feedback history</summary><ul>
      {learning.feedback.map(item => <li key={item.id}>{item.reason} <small>{new Date(item.created_at).toLocaleString()}</small></li>)}
    </ul></details>}
  </section>;
}
