import React, { useEffect, useRef, useState } from "react";
import { BriefButton, BriefInput, BriefSelect } from "../components/controls";
import { formatNumber } from "../today/outcomes/model";
import type { GoalsController } from "./controller";
import { measureKind, type GoalDatum, type GoalWrite } from "./model";

export type LogMode = "log" | "define";
const NOTE_MAX = 200, LINK_MAX = 500, UNIT_MAX = 80, COUNT_MAX = 1000;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** Local time as a datetime-local value. */
function localInput(at: number) {
  const d = new Date(at), pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const hasControl = (value: string) => /\p{Cc}/u.test(value);

/** One goal's "Log progress" or "Set how to measure this" form. The host owns the write and its rules. */
export function LogProgress({ goal, mode, controller, onDone, onCancel }: {
  goal: GoalDatum;
  mode: LogMode;
  controller: GoalsController;
  onDone: (saved: string) => void;
  onCancel: () => void;
}) {
  const kind = measureKind(goal);
  const panel = useRef<HTMLElement>(null);
  // The form can open far below the card that asked for it: bring it into view and start typing.
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "center" });
    panel.current?.querySelector<HTMLElement>("input, select")?.focus({ preventScroll: true });
  }, []);
  return (
    <section ref={panel} className="brief-goal-log brief-surface" aria-label={mode === "define" ? "Set how to measure this" : "Log progress"} data-goal-id={goal.goalId}>
      <h3 className="brief-type-body-emphasis">
        {mode === "define" ? "Set how to measure this" : "Log progress"}: {goal.pathLabel || goal.title}
      </h3>
      {mode === "define" || kind === "none"
        ? <DefineForm goal={goal} controller={controller} onDone={onDone} onCancel={onCancel} />
        : kind === "count"
          ? <EntryForm goal={goal} controller={controller} onDone={onDone} onCancel={onCancel} />
          : <ValueForm goal={goal} controller={controller} onDone={onDone} onCancel={onCancel} />}
    </section>
  );
}
interface FormProps { goal: GoalDatum; controller: GoalsController; onDone: (saved: string) => void; onCancel: () => void }

/** A retry of the same entry keeps its request id; any edit starts a new one. */
function useAttempt() {
  const id = useRef(newId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return {
    busy, error, setError,
    edited: () => { id.current = newId(); setError(""); },
    async save(run: (requestId: string) => Promise<GoalWrite>, saved: string, onDone: (saved: string) => void) {
      setBusy(true); setError("");
      const result = await run(id.current);
      setBusy(false);
      if (result.ok) { id.current = newId(); onDone(saved); } else setError(result.message);
    },
  };
}
function Actions({ busy, label, onCancel }: { busy: boolean; label: string; onCancel: () => void }) {
  return (
    <div className="brief-goal-log-actions">
      <BriefButton type="submit" variant="primary" disabled={busy}>{busy ? "Saving..." : label}</BriefButton>
      <BriefButton type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</BriefButton>
    </div>
  );
}
function Failure({ message }: { message: string }) {
  return <p role="alert" className="brief-goal-log-error brief-type-utility">{message}</p>;
}

function ValueForm({ goal, controller, onDone, onCancel }: FormProps) {
  const unit = goal.measurementDefinition!.unit;
  const [value, setValue] = useState(goal.measurement ? String(goal.measurement.value) : "");
  const [at, setAt] = useState(() => localInput(Date.now()));
  const [touched, setTouched] = useState(false);
  const attempt = useAttempt();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const number = value.trim() === "" ? NaN : Number(value);
    if (!Number.isFinite(number)) return attempt.setError("Enter the new value as a number.");
    const picked = touched ? new Date(at).getTime() : Date.now();
    if (!Number.isFinite(picked)) return attempt.setError("Enter a valid date and time.");
    if (picked > Date.now()) return attempt.setError("The time you measured it cannot be in the future.");
    void attempt.save((requestId) => controller.logValue(goal, { requestId, value: number, measuredAt: picked }),
      `Saved ${formatNumber(number)} ${unit}.`, onDone);
  };
  return (
    <form onSubmit={submit} noValidate>
      <BriefInput label={`New value (${unit})`} inputMode="decimal" value={value} disabled={attempt.busy}
        onChange={(e) => { setValue(e.target.value); attempt.edited(); }}
        hint={goal.measurement ? `Last logged: ${formatNumber(goal.measurement.value)} ${unit}` : `Target: ${formatNumber(goal.measurementDefinition!.target)} ${unit}`} />
      <BriefInput label="Measured at" type="datetime-local" value={at} disabled={attempt.busy}
        onChange={(e) => { setAt(e.target.value); setTouched(true); attempt.edited(); }} />
      {attempt.error && <Failure message={attempt.error} />}
      <Actions busy={attempt.busy} label="Save progress" onCancel={onCancel} />
    </form>
  );
}

function EntryForm({ goal, controller, onDone, onCancel }: FormProps) {
  const unit = goal.measurementDefinition!.unit;
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const attempt = useAttempt();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const name = note.trim(), url = link.trim();
    if (!name) return attempt.setError("Say what you are counting, in a few words.");
    if (name.length > NOTE_MAX) return attempt.setError(`Keep the note under ${NOTE_MAX} characters.`);
    if (hasControl(name) || hasControl(url)) return attempt.setError("Use plain text without line breaks.");
    if (url.length > LINK_MAX) return attempt.setError("That link is too long.");
    void attempt.save((requestId) => controller.addEntry(goal, { requestId, note: name, link: url }),
      `Added ${name}.`, onDone);
  };
  return (
    <form onSubmit={submit} noValidate>
      <BriefInput label={`What did you add to the count of ${unit}?`} value={note} maxLength={NOTE_MAX} disabled={attempt.busy}
        placeholder="For example: Acme signed" onChange={(e) => { setNote(e.target.value); attempt.edited(); }} />
      <BriefInput label="Link (optional)" type="url" value={link} disabled={attempt.busy}
        placeholder="https://" onChange={(e) => { setLink(e.target.value); attempt.edited(); }} />
      {attempt.error && <Failure message={attempt.error} />}
      <Actions busy={attempt.busy} label="Add to the count" onCancel={onCancel} />
    </form>
  );
}

function DefineForm({ goal, controller, onDone, onCancel }: FormProps) {
  const existing = goal.measurementDefinition;
  // The server keeps a counted goal counted, and keeps what it counts once it has entries.
  const counted = measureKind(goal) === "count", unitLocked = counted && !!goal.measurement;
  const [kind, setKind] = useState<"number" | "count">(counted ? "count" : "number");
  const [unit, setUnit] = useState(existing?.unit ?? "");
  const [baseline, setBaseline] = useState(existing ? String(existing.baseline) : "0");
  const [target, setTarget] = useState(existing ? String(existing.target) : "");
  const attempt = useAttempt();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // A counted goal keeps the starting count it was defined with; this form has no field for it.
    const label = unit.trim(), from = kind === "count" ? (counted ? existing!.baseline : 0) : Number(baseline), to = Number(target);
    if (!label || label.length > UNIT_MAX || hasControl(label)) return attempt.setError("Say what you measure, in a few words (for example: customers, euros).");
    if (target.trim() === "" || !Number.isFinite(to) || (kind === "number" && (baseline.trim() === "" || !Number.isFinite(from))))
      return attempt.setError("Enter the numbers you start from and aim for.");
    if (kind === "count" && (!Number.isInteger(to) || to <= from || to < 1 || to > COUNT_MAX)) return attempt.setError(`The target must be a whole number from ${Math.max(1, from + 1)} to ${COUNT_MAX}.`);
    if (kind === "number" && from === to) return attempt.setError("The target must differ from where you start.");
    void attempt.save((requestId) => controller.defineMeasure(goal, { requestId, kind, unit: label, baseline: from, target: to }),
      "Saved. You can log progress now.", onDone);
  };
  return (
    <form onSubmit={submit} noValidate>
      {!counted && (
        <BriefSelect label="How do you measure it?" value={kind} disabled={attempt.busy}
          hint={kind === "count" ? "A count cannot be switched back to a number later." : undefined}
          onChange={(e) => { setKind(e.target.value as "number" | "count"); attempt.edited(); }}>
          <option value="number">A number I update</option>
          <option value="count">A count of things</option>
        </BriefSelect>
      )}
      <BriefInput label="What you measure" value={unit} maxLength={UNIT_MAX} disabled={attempt.busy || unitLocked}
        hint={unitLocked ? "This stays the same once the count has entries." : undefined}
        placeholder={kind === "count" ? "customers" : "euros"} onChange={(e) => { setUnit(e.target.value); attempt.edited(); }} />
      {kind === "number" && (
        <BriefInput label="Starting value" inputMode="decimal" value={baseline} disabled={attempt.busy}
          onChange={(e) => { setBaseline(e.target.value); attempt.edited(); }} />
      )}
      <BriefInput label="Target" inputMode="decimal" value={target} disabled={attempt.busy}
        onChange={(e) => { setTarget(e.target.value); attempt.edited(); }} />
      {attempt.error && <Failure message={attempt.error} />}
      <Actions busy={attempt.busy} label="Save" onCancel={onCancel} />
    </form>
  );
}
