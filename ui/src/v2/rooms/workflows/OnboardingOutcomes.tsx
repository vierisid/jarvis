/**
 * #1261: a customer onboarding branch (ClickUp task or Drive folder) whose
 * outcome is unknown is never retried or reused until a person resolves it.
 * The run that left it succeeds with a Notify summary, so the recovery inbox
 * (failed runs only) never shows it: this is its dashboard control, on the
 * run itself. The two choices, the resource check and the route are the ones
 * the assistant's resolve_onboarding action uses (#1243). The assistant needs
 * an approval card because it acts for the person; here the person decides
 * directly, after a confirmation, as for the other dashboard recovery
 * decisions. Nothing is created or run.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { onboardingResource, type ResourceBranch } from "../../../../../src/workflows/onboarding-accounts";
import { confirmDialog } from "../../ui/ConfirmDialog";
import { Button } from "../../ui";

type BranchState = { status: "succeeded" | "failed" | "unknown" | "dispatching"; url?: string; detail?: string };
interface RunOnboarding {
  effectId: string;
  customer: { id: string; name: string | null };
  running: boolean;
  branches: Partial<Record<ResourceBranch, BranchState>>;
}

const LABEL: Record<ResourceBranch, string> = { clickup: "ClickUp task", drive: "Drive folder" };
const unresolved = (state?: BranchState) => state?.status === "unknown" || state?.status === "dispatching";

export function OnboardingOutcomes({ runId }: { runId: string }): React.ReactElement | null {
  const [onboardings, setOnboardings] = useState<RunOnboarding[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}/onboarding`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { onboardings?: unknown };
      if (!Array.isArray(body.onboardings)) throw new Error("Invalid onboarding outcomes");
      setOnboardings(body.onboardings as RunOnboarding[]); setError(false);
    } catch {
      if (!signal?.aborted) setError(true);
    }
  }, [runId]);
  useEffect(() => {
    const request = new AbortController();
    void load(request.signal);
    return () => request.abort();
  }, [load]);

  const failed = error ? <p className="wf-runs__onboarding-err" role="alert">
    Couldn't check this run's customer onboarding outcomes. <Button size="sm" variant="ghost" onClick={() => void load()}>Try again</Button>
  </p> : null;
  const open = (onboardings ?? []).flatMap(o => (["clickup", "drive"] as const).filter(b => unresolved(o.branches[b])).map(branch => ({ onboarding: o, branch })));
  if (open.length === 0) return failed;
  return (
    <section className="wf-runs__onboarding" aria-label="Customer onboarding to review">
      <strong>Customer onboarding to review</strong>
      {failed}
      <p>Check ClickUp or Drive, then record what you found. Until then this customer's {open.length === 1 ? LABEL[open[0]!.branch] : "resources"} will not be created or reused.</p>
      {open.map(({ onboarding, branch }) => (
        <OnboardingBranch key={`${onboarding.effectId}:${branch}`} runId={runId} onboarding={onboarding} branch={branch}
          several={onboardings!.length > 1} onResolved={() => void load()} />
      ))}
    </section>
  );
}

function OnboardingBranch({ runId, onboarding, branch, several, onResolved }: {
  runId: string; onboarding: RunOnboarding; branch: ResourceBranch; several: boolean; onResolved: () => void;
}): React.ReactElement {
  const [resource, setResource] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const deciding = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const state = onboarding.branches[branch]!;
  const who = onboarding.customer.name ? `${onboarding.customer.name} (${onboarding.customer.id})` : onboarding.customer.id;
  const label = LABEL[branch];

  const decide = async (resolution: "mark_done" | "release") => {
    if (deciding.current) return;
    setMessage(null);
    let link: string | undefined;
    if (resolution === "mark_done") {
      try { link = onboardingResource(branch, resource).url; } catch (e) { setMessage((e as Error).message); return; }
    }
    // Busy from the first click, so a second choice cannot queue its own
    // dialog and POST (the ref holds before the disabled buttons render).
    deciding.current = true; setBusy(true);
    const question = resolution === "mark_done"
      ? `Record that the ${label} for ${who} was created?\nLater runs for this customer reuse ${link} and never create another.`
      : `Record that the ${label} for ${who} was not created?\nThe next run for this customer creates it.`;
    try {
      if (!await confirmDialog(question, { confirmLabel: "Record decision", danger: false })) return;
      const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}/effects/${encodeURIComponent(onboarding.effectId)}/onboarding`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch, resolution, ...(resolution === "mark_done" ? { resource: resource.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        setMessage(typeof body?.error === "string" ? body.error : `Could not record the decision (HTTP ${res.status}).`);
        return;
      }
      onResolved();
    } catch {
      setMessage("Could not record the decision. Check the connection and try again.");
    } finally { deciding.current = false; setBusy(false); }
  };

  const id = `onb-${onboarding.effectId}-${branch}`;
  return (
    <div className="wf-runs__onboarding-branch" role="group" aria-label={`${label} for ${who}`}>
      <p>
        <strong>{label}</strong>{several || onboarding.customer.name ? <> for {who}</> : null}: {state.status !== "dispatching" ? "outcome unknown" : onboarding.running ? "being created" : "creation was interrupted"}.
        {state.detail ? <> {state.detail}</> : null}
      </p>
      {onboarding.running ? <p>A run is onboarding this customer now. Check again when it finishes.</p> : <>
        <label htmlFor={`${id}-resource`}>If it was created, its ID or link</label>
        <input id={`${id}-resource`} value={resource} disabled={busy} onChange={e => setResource(e.target.value)}
          placeholder={branch === "clickup" ? "https://app.clickup.com/t/..." : "https://drive.google.com/drive/folders/..."} />
        <label htmlFor={`${id}-note`}>Note (optional)</label>
        <input id={`${id}-note`} value={note} disabled={busy} maxLength={2000} onChange={e => setNote(e.target.value)} />
        <div className="wf-runs__onboarding-actions">
          <Button size="sm" variant="ghost" disabled={busy || !resource.trim()} onClick={() => void decide("mark_done")}>It was created</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("release")}>It was not created</Button>
        </div>
      </>}
      {message ? <p className="wf-runs__onboarding-err" role="alert">{message}</p> : null}
    </div>
  );
}
