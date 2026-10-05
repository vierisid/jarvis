import React, { useEffect, useRef, useState } from "react";
import { Check, CreditCard, Settings, Trash2, User, X } from "lucide-react";
import { BriefButton, BriefIconButton, BriefLink } from "./Buttons";
import type { ActionState, ControlSize } from "./Buttons";
import { BriefInput, BriefSelect, BriefTextarea } from "./Fields";
import { BriefSegments, BriefSwitch, BriefTabs } from "./Choices";
import { BriefMenu } from "./Floating";
import "./specimen.css";

/** D-03 fixtures only. No requests, account mutations or business providers. */
export function ControlSpecimen() {
  const [theme, setTheme] = useState("light");
  const [width, setWidth] = useState("wide");
  const [size, setSize] = useState<ControlSize>("md");
  const [name, setName] = useState("Vieri Balboni");
  const [state, setState] = useState<ActionState>("idle");
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [tab, setTab] = useState("active");
  const [frequency, setFrequency] = useState("weekly");
  const [confirm, setConfirm] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [notice, setNotice] = useState("Nothing changed. All examples stay on this page.");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const nameError = "Enter a name before saving.";
  function save(event: React.FormEvent) {
    event.preventDefault();
    if (state === "pending") return;
    if (!name.trim()) { setInvalid(true); setState("error"); return; }
    setInvalid(false); setState("pending");
    timer.current = setTimeout(() => setState(failure ? "error" : "success"), 900);
  }
  return <main className="brief-root brief-control-specimen" data-brief-theme={theme}>
    <header className="brief-control-specimen__header">
      <div><p className="brief-control-specimen__eyebrow">D-03 · Interactive reference</p>
        <h1>Shared controls.</h1><p>The small things, working together. Local examples, no live account changes.</p></div>
      <div className="brief-control-specimen__tools">
        <BriefSegments label="Preview appearance" value={theme} onValueChange={setTheme}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <BriefSegments label="Preview width" value={width} onValueChange={setWidth}
          options={[{ value: "wide", label: "Wide" }, { value: "compact", label: "Narrow" }]} />
        <BriefSegments label="Control density" value={size} onValueChange={value => setSize(value as ControlSize)}
          options={[{ value: "md", label: "Standard" }, { value: "sm", label: "Compact" }]} />
      </div>
    </header>
    <div className="brief-control-specimen__body" data-width={width}>
      <section aria-labelledby="actions-heading">
        <div className="brief-control-specimen__caption"><span>01</span><h2 id="actions-heading">A clear next action</h2></div>
        <div className="brief-control-specimen__row">
          <BriefButton size={size} variant="primary" onClick={() => setNotice("Primary action selected.")}>Review follow-up</BriefButton>
          <BriefButton size={size} variant="secondary" onClick={() => setNotice("Secondary action selected.")}>Keep draft</BriefButton>
          <BriefButton size={size} variant="text" onClick={() => setNotice("Text action selected.")}>Cancel</BriefButton>
          <BriefButton size={size} disabled>Unavailable</BriefButton>
          <BriefLink href="?brief=preview&specimen=styles#/_brief_preview">Open style reference</BriefLink>
        </div>
      </section>

      <section id="control-form" aria-labelledby="fields-heading">
        <div className="brief-control-specimen__caption"><span>02</span><h2 id="fields-heading">Space to write. Room for feedback.</h2></div>
        <form onSubmit={save} noValidate>
          <div className="brief-control-specimen__grid">
            <BriefInput density={size} label="Full name" value={name} required
              onChange={event => { setName(event.target.value); setInvalid(false); setState("idle"); }}
              readOnly={state === "pending"} hint="Shown in your workspace." reserveMessage={nameError}
              error={invalid ? nameError : undefined} saved={state === "success" ? "Name saved in this example." : undefined} />
            <BriefInput density={size} label="Email address" type="email" defaultValue="vieri.balboni+design-review@example.com"
              hint="A long value stays inside its field." />
            <BriefSelect density={size} label="Summary frequency" defaultValue="weekly" hint="Native selection, shared geometry.">
              <option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option>
            </BriefSelect>
            <BriefInput density={size} label="Workspace ID" defaultValue="workspace-example" disabled hint="Disabled, with the value still readable." />
          </div>
          <BriefTextarea density={size} label="Notes" defaultValue={"Keep updates concise.\nPut the next decision first."} hint="Multiline content keeps its own space." />
          <div className="brief-control-specimen__row">
            <BriefButton type="submit" size={size} variant="primary" state={state}
              stateLabels={{ pending: "Saving…", success: "Changes saved", error: "Try again" }}>Save changes</BriefButton>
            <label className="brief-control-specimen__check"><input type="checkbox" checked={failure} disabled={state === "pending"}
              onChange={event => setFailure(event.target.checked)} />Simulate a failed save</label>
          </div>
          <p className="brief-control-specimen__feedback" role="status">
            {state === "error" && !invalid ? "The example did not save. Your values are still here." : "\u00a0"}
          </p>
        </form>
      </section>

      <section aria-labelledby="choices-heading">
        <div className="brief-control-specimen__caption"><span>03</span><h2 id="choices-heading">Selection that stays clear</h2></div>
        <BriefTabs label="Example work" value={tab} onValueChange={setTab} items={[
          { value: "active", label: "Active", content: <BriefInput label="A retained draft" defaultValue="Your work stays when you switch tabs." hint="Edit this, then visit Completed and return." /> },
          { value: "completed", label: "Completed", content: <p className="brief-control-specimen__completed"><Check size={18} /> The selected tab changes. Your draft stays.</p> },
          { value: "unavailable", label: "Unavailable", disabled: true, content: null },
        ]} />
        <BriefSegments label="Example schedule" value={frequency} onValueChange={setFrequency} options={[
          { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" },
        ]} />
        <div className="brief-control-specimen__switches">
          <div><span>Workflow activation</span><BriefSwitch label="Workflow activation" checked={enabled} onCheckedChange={setEnabled} onLabel="Enabled" offLabel="Paused" /></div>
          <div><span>Disabled, on</span><BriefSwitch label="Disabled on example" checked onCheckedChange={() => {}} disabled /></div>
          <div><span>Disabled, off</span><BriefSwitch label="Disabled off example" checked={false} onCheckedChange={() => {}} disabled /></div>
        </div>
      </section>

      <section aria-labelledby="utilities-heading">
        <div className="brief-control-specimen__caption"><span>04</span><h2 id="utilities-heading">Small targets. Considered behavior.</h2></div>
        <div className="brief-control-specimen__row">
          <BriefIconButton size={size} label="Close panel" icon={<X />} onClick={() => setNotice("Close control selected. This is a specimen.")} />
          <BriefIconButton size={size} label="Delete example" icon={<Trash2 />} intent="destructive" disabled={removed}
            onClick={() => setConfirm(true)} />
          <BriefIconButton size={size} label="Unavailable action" icon={<Settings />} disabled />
          <p>Hover or focus for a label. Escape dismisses it.</p>
        </div>
        <div className="brief-control-specimen__confirmation" aria-live="polite">
          {confirm ? <><span>Delete this example?</span><BriefButton size={size} variant="danger" onClick={() => { setConfirm(false); setRemoved(true); }}>Delete</BriefButton>
            <BriefButton size={size} variant="secondary" onClick={() => setConfirm(false)}>Keep example</BriefButton></>
            : removed ? <><span>Example removed.</span><BriefButton size={size} variant="text" onClick={() => setRemoved(false)}>Undo</BriefButton></>
            : <span className="brief-control-specimen__quiet">Confirmation stays beside the action.</span>}
        </div>
        <div className="brief-control-specimen__clip">
          <BriefMenu label="Account example" items={[
            { id: "profile", label: "Profile", icon: <User size={16} />, onSelect: () => setNotice("Profile selected in this example.") },
            { id: "settings", label: "Settings", icon: <Settings size={16} />, onSelect: () => setNotice("Settings selected in this example.") },
            { id: "billing", label: "Billing", icon: <CreditCard size={16} />, onSelect: () => setNotice("Billing selected in this example.") },
            { id: "disabled", label: "Unavailable example", disabled: true, onSelect: () => {} },
          ]} />
          <span>A menu escapes this clipped container.</span>
        </div>
        <BriefButton size={size} variant="text" onClick={() => setNotice("Focus left the menu normally.")}>Next control</BriefButton>
      </section>
      <footer><p role="status">{notice}</p><BriefLink direction="back" href="?brief=preview#/_brief_preview">Brief foundation</BriefLink></footer>
    </div>
  </main>;
}
