/**
 * What a person allowed this workflow to do beyond its approved pieces. The
 * routes behind it are dashboard-only: the assistant cannot grant a flow
 * these, so the grant happens here, after a confirmation for anything that
 * widens what the flow may do. Narrowing asks nothing.
 */
import React, { useRef, useState } from "react";
import { confirmDialog } from "../../ui/ConfirmDialog";
import { Button } from "../../ui";
import type { Flow } from "./useWorkflowsData";

type CodeSteps = NonNullable<Flow["codeSteps"]>;

function grantNote(grantedBy: "user" | "upgrade" | null | undefined, grantedAt: number | null | undefined): string {
  if (grantedBy === "upgrade") return " Added at upgrade, because this workflow already did this before the setting existed.";
  if (grantedBy === "user" && grantedAt) return ` Allowed ${new Date(grantedAt).toLocaleString()}.`;
  return "";
}

/**
 * A flow name as a confirmation quotes it. The name may come from a model
 * (compose), so it is one short line: it cannot add lines or paragraphs to the
 * dialog that grants the permission.
 */
function quotedName(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\s]+/g, " ").trim();
  return `"${line.length > 80 ? line.slice(0, 77) + "..." : line}"`;
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `${fallback} (HTTP ${res.status}).`;
}

/**
 * The value to show: the latest the server answered a change with, until the
 * list it polls changes. A poll that read the flow before the change landed
 * still holds the old value, unchanged from the last one seen, so it does not
 * undo what this view just saved.
 */
function useLatest<T>(fromList: T): [T, (value: T) => void] {
  const seen = useRef(JSON.stringify(fromList));
  const [saved, setSaved] = useState<T | null>(null);
  const key = JSON.stringify(fromList);
  if (key !== seen.current) {
    seen.current = key;
    if (saved !== null) setSaved(null);
    return [fromList, setSaved];
  }
  return [saved ?? fromList, setSaved];
}

export function FlowPermissions({ flow, onChanged }: { flow: Flow; onChanged: () => void }): React.ReactElement {
  const name = quotedName(flow.displayName ?? flow.id);
  const [code, setCode] = useLatest<CodeSteps | undefined>(flow.codeSteps);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const [message, setMessage] = useState<string | null>(null);

  const setCodeSteps = async (enabled: boolean) => {
    if (acting.current) return;
    // Busy from the first click, so a second click cannot queue its own dialog and POST.
    acting.current = true; setBusy(true); setMessage(null);
    try {
      if (enabled && !await confirmDialog(
        `Allow CODE steps in the workflow ${name}?\nA CODE step runs custom JavaScript on the computer Jarvis runs on, with your user's full access to its files, network and shell, and installs the packages it declares. It runs without an approval card. This covers any CODE step added to this workflow later. Allow it only for code you trust.`,
        { title: "Allow CODE steps?", confirmLabel: "Allow CODE steps", danger: true },
      )) return;
      const res = await fetch(`/api/workflows/${encodeURIComponent(flow.id)}/code-steps`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      if (!res.ok) { setMessage(await errorText(res, "Could not change CODE steps")); return; }
      const saved = await res.json().catch(() => null) as { codeSteps?: CodeSteps } | null;
      if (saved?.codeSteps) setCode(saved.codeSteps);
      onChanged();
    } catch {
      setMessage("Could not change CODE steps. Check the connection and try again.");
    } finally { acting.current = false; setBusy(false); }
  };

  return (
    <section className="wf-detail__permissions" aria-label="Flow permissions">
      <h4>Flow permissions</h4>
      <div className="wf-detail__permission">
        <p>
          <strong>CODE steps</strong>: {code?.enabled
            ? <>allowed.{grantNote(code.grantedBy, code.grantedAt)}</>
            : "not allowed. A version with a CODE step cannot be published, enabled or run. Turning this off does not stop a run already going or a schedule already set up; disable the workflow to stop those."}
        </p>
        {code ? (code.enabled
          ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setCodeSteps(false)}>Stop allowing CODE steps</Button>
          : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void setCodeSteps(true)}>Allow CODE steps</Button>) : null}
      </div>
      {message ? <p className="wf-detail__permission-err" role="alert">{message}</p> : null}
    </section>
  );
}
