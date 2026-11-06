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
type ReadHostList = NonNullable<Flow["readHosts"]>;

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
      {flow.readHosts ? <ReadHosts flow={flow} list={flow.readHosts} name={name} onChanged={onChanged} /> : null}
    </section>
  );
}

/** The server's ceiling on one flow's read list. */
const MAX_READ_HOSTS = 64;

/**
 * A typed host as the server will store it (lowercase, punycode), or null when
 * it is not a bare host name; then it is sent as typed and the server says why
 * it refuses it.
 */
function grantedForm(typed: string): string | null {
  if (!typed || /[/:@?#\\\s]/.test(typed)) return null;
  try { return new URL(`http://${typed}`).hostname; } catch { return null; }
}

/**
 * The hosts this flow's HTTP GET steps may read without an approval card. Adding
 * one widens what runs unasked, so it is confirmed; removing one narrows it.
 * The whole list is sent each time, built from the latest list this view knows
 * when the request goes out; the server checks each host and says why it
 * refuses one.
 */
function ReadHosts({ flow, list: fromList, name, onChanged }: { flow: Flow; list: ReadHostList; name: string; onChanged: () => void }): React.ReactElement {
  const [list, setList] = useLatest<ReadHostList>(fromList);
  const current = useRef(list);
  current.current = list;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const [message, setMessage] = useState<string | null>(null);

  /** `next` is built after any confirmation, from the list as it is then. */
  const save = async (next: (hosts: string[]) => string[], ask?: { title: string; message: string }): Promise<boolean> => {
    if (acting.current) return false;
    acting.current = true; setBusy(true); setMessage(null);
    try {
      if (ask && !await confirmDialog(ask.message, { title: ask.title, confirmLabel: "Add host", danger: true })) return false;
      const res = await fetch(`/api/workflows/${encodeURIComponent(flow.id)}/read-hosts`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hosts: next(current.current.hosts) }),
      });
      if (!res.ok) { setMessage(await errorText(res, "Could not change the read list")); return false; }
      const saved = await res.json().catch(() => null) as { readHosts?: ReadHostList } | null;
      if (saved?.readHosts && Array.isArray(saved.readHosts.hosts)) { setList(saved.readHosts); current.current = saved.readHosts; }
      onChanged();
      return true;
    } catch {
      setMessage("Could not change the read list. Check the connection and try again.");
      return false;
    } finally { acting.current = false; setBusy(false); }
  };

  const add = async () => {
    const typed = draft.trim().toLowerCase();
    if (!typed) return;
    const host = grantedForm(typed) ?? typed;
    if (current.current.hosts.includes(host)) { setDraft(""); return; }
    // Show the host as it will be granted; a lookalike typed in another script shows its punycode.
    const shown = host === typed ? host : `${host} (typed as ${typed})`;
    const ok = await save(hosts => hosts.includes(host) ? hosts : [...hosts, host], {
      title: "Read this host without asking?",
      message: `Let the workflow ${name} send HTTP GET requests to ${shown} without asking?\nThey run without an approval card, including whatever the workflow puts in their address or headers. Requests that send, change or delete still ask.`,
    });
    if (ok) setDraft("");
  };
  const remove = (host: string) => void save(hosts => hosts.filter(h => h !== host));

  const id = `wf-read-hosts-${flow.id}`;
  return (
    <div className="wf-detail__permission wf-detail__read-hosts">
      <p>
        <strong>Hosts it may read without asking</strong>: {list.hosts.length ? `${list.hosts.length}.` : "none. Each HTTP GET step asks first."}
        {list.hosts.length ? grantNote(list.grantedBy, list.grantedAt) : null}
      </p>
      {list.hosts.length ? (
        <ul className="wf-detail__host-list" aria-label="Hosts it may read without asking">
          {list.hosts.map(host => (
            <li key={host}>
              <code>{host}</code>
              <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${host}`} onClick={() => remove(host)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="wf-detail__host-add" onSubmit={e => { e.preventDefault(); void add(); }}>
        <label htmlFor={id}>Add a host</label>
        <input id={id} value={draft} disabled={busy || list.hosts.length >= MAX_READ_HOSTS} placeholder="api.example.com"
          autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={253} onChange={e => setDraft(e.target.value)} />
        <Button size="sm" variant="ghost" type="submit" disabled={busy || !draft.trim() || list.hosts.length >= MAX_READ_HOSTS}>Add</Button>
      </form>
      {list.hosts.length >= MAX_READ_HOSTS ? <p>This flow has the most hosts it can list ({MAX_READ_HOSTS}).</p> : null}
      {message ? <p className="wf-detail__permission-err" role="alert">{message}</p> : null}
    </div>
  );
}
